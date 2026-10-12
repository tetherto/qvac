r"""Production `tetherto.qvac_sdk._transport.Transport` implementation, backed by
`bare_rpc.RPC` (github.com/holepunchto/bare-rpc-python).

The worker runs under the SDK's TCP shim, which connects back to a loopback
port this module listens on (`127.0.0.1:0`, the port passed as the shim's last
argument) -- one code path on every OS, with no pipe handed to the child. The
connection carries bare-stow's worker framing: each frame is a 4-byte
little-endian length counting the tag and the payload, a 1-byte tag (0 control,
1 user data), then the payload. User data is the bare-rpc byte stream; control
payloads are JSON -- `ready`, `exit` and `error` from the worker, `terminate`
to it.

Any local user can dial a loopback port, so the worker authenticates: it gets
a per-session token in its environment (readable only by the same user or
root, unlike argv) and the shim writes it, newline-terminated, before any
frame. Only the first connection that presents it is wired to the RPC; the
listener then closes.

Locating the Bare binary, the shim and the worker entry is not this module's
job -- `command` is supplied by the caller.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import os
import secrets
import struct
from collections.abc import AsyncIterable, AsyncIterator, Sequence
from typing import Any

import bare_rpc

from .errors import reconstruct_error

_IPC_TOKEN_ENV = "QVAC_IPC_AUTH_TOKEN"
_HANDSHAKE_TIMEOUT = 10
_CONTROL = 0
_DATA = 1
_HEADER = struct.Struct("<IB")
_TERMINATE_TIMEOUT = 10
_MAX_FRAME_BYTES = 256 * 1024 * 1024


def _frame(tag: int, payload: bytes) -> bytes:
    return _HEADER.pack(len(payload) + 1, tag) + payload


class WorkerError(Exception):
    """The worker reported an error through bare-stow before it exited."""

    def __init__(self, message: str, stack: str | None) -> None:
        super().__init__(message)
        self.stack = stack


class _FrameReader:
    """Splits bare-stow frames out of the socket's byte stream."""

    def __init__(self) -> None:
        self._buffer = bytearray()

    def feed(self, chunk: bytes) -> list[tuple[int, bytes]]:
        self._buffer.extend(chunk)
        frames: list[tuple[int, bytes]] = []
        while len(self._buffer) >= 4:
            (length,) = struct.unpack_from("<I", self._buffer)
            if length < 1 or length > _MAX_FRAME_BYTES:
                raise ValueError(f"bare-stow frame length out of range: {length}")
            if len(self._buffer) < 4 + length:
                break
            tag = self._buffer[4]
            frames.append((tag, bytes(self._buffer[5 : 4 + length])))
            del self._buffer[: 4 + length]
        return frames


def _patch_bare_rpc_outgoing_destroy() -> None:
    """Work around a bare-rpc-python bug: `RPC._on_stream` handles a peer STREAM
    DESTROY frame by calling the *async* `OutgoingStream.destroy()` without
    awaiting or scheduling it, so the coroutine is dropped -- the outgoing stream
    is never closed and Python warns "coroutine 'OutgoingStream.destroy' was
    never awaited" (seen tearing down the completion-orchestrate duplex). Wrap
    `destroy` so it schedules the original on the RPC's own task set -- it
    actually runs and stays referenced -- and returns the task, so a direct
    `await stream.destroy()` keeps working too. Idempotent. Remove once bare-rpc
    schedules/awaits the destroy itself.
    """
    outgoing_stream = bare_rpc.OutgoingStream
    original = outgoing_stream.destroy
    if getattr(original, "_qvac_scheduled", False):
        return

    def destroy(self, error=None):
        task = asyncio.ensure_future(original(self, error))
        self._rpc._tasks.add(task)
        task.add_done_callback(self._rpc._tasks.discard)
        return task

    destroy._qvac_scheduled = True  # type: ignore[attr-defined]
    outgoing_stream.destroy = destroy  # type: ignore[method-assign]


_patch_bare_rpc_outgoing_destroy()


def _json_or_raise(data: bytes) -> Any:
    """Parse a JSON payload; the SDK reports failures in-band as
    {"type": "error", ...} envelopes -- rebuild the typed error (or a generic
    RPCError) so callers get `isinstance`-able classes, not strings."""
    obj = json.loads(data.decode("utf-8"))
    if isinstance(obj, dict) and obj.get("type") == "error":
        raise reconstruct_error(obj)
    return obj


async def _iter_json_lines(chunks: AsyncIterator[bytes]) -> AsyncIterator[Any]:
    """Parse a stream of raw byte chunks into newline-delimited JSON values.

    Scans for newlines from a running offset and compacts the consumed prefix
    once per chunk, so a large frame arriving across many chunks (e.g. a big
    base64 audio buffer on a duplex stream) costs O(bytes), not O(chunks^2)
    from re-splitting a growing buffer on every chunk."""
    buffer = bytearray()
    start = 0
    async for chunk in chunks:
        buffer.extend(chunk)
        while True:
            nl = buffer.find(b"\n", start)
            if nl == -1:
                start = len(buffer)
                break
            line = bytes(buffer[start:nl])
            start = nl + 1
            if line.strip():
                yield _json_or_raise(line)
        if start:
            del buffer[:start]
            start = 0
    if buffer.strip():
        yield _json_or_raise(bytes(buffer))


class BareRpcTransport:
    """Spawns a QVAC SDK worker and speaks to it via `bare_rpc.RPC`,
    satisfying `tetherto.qvac_sdk._transport.Transport`'s async call/call_stream/call_duplex
    shape directly.

    `command` is the Bare invocation up to (not including) the port, e.g.
    `["bare", "/path/to/tcp-shim.js", "/path/to/worker.js"]` -- this class
    appends the port itself, since that handshake is protocol, not caller,
    concern.
    """

    def __init__(
        self,
        command: Sequence[str],
        *,
        home_dir: str | None = None,
        config: dict[str, Any] | None = None,
    ) -> None:
        self._command = list(command)
        # QVAC_HOME_DIR lets CI/tests pin the worker's storage root (models,
        # registry) to a cacheable, per-OS-explicit path instead of the
        # ambiguous expanduser("~") (which Windows resolves via USERPROFILE).
        self._home_dir = (
            home_dir or os.environ.get("QVAC_HOME_DIR") or os.path.expanduser("~")
        )
        # SDK runtime config (QvacConfig: cacheDirectory, loggerLevel,
        # swarmRelays, plugin/device defaults, ...), sent to the worker as an
        # `__init_config` message on connect -- the same mechanism the JS client
        # uses. QVAC_CACHE_DIR is a convenience env for the common cacheDirectory
        # override (e.g. a shared CI model cache).
        merged_config = dict(config or {})
        cache_dir = os.environ.get("QVAC_CACHE_DIR")
        if cache_dir and "cacheDirectory" not in merged_config:
            merged_config["cacheDirectory"] = cache_dir
        self._config: dict[str, Any] = merged_config
        self._server: asyncio.AbstractServer | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._read_task: asyncio.Task | None = None
        self._handshakes: set[asyncio.Task] = set()
        self._ready: asyncio.Future[None] | None = None
        self._exited: asyncio.Future[int | None] | None = None
        self._close_reason: BaseException | None = None
        self.rpc: bare_rpc.RPC | None = None

    @property
    def worker_error(self) -> WorkerError | None:
        reason = self._close_reason
        return reason if isinstance(reason, WorkerError) else None

    def _on_control(self, payload: bytes) -> None:
        try:
            message = json.loads(payload.decode("utf-8"))
        except ValueError:
            return
        if not isinstance(message, dict):
            return
        kind = message.get("type")
        if kind == "ready" and self._ready and not self._ready.done():
            self._ready.set_result(None)
        elif kind == "exit" and self._exited and not self._exited.done():
            self._exited.set_result(message.get("code"))
        elif kind == "error":
            error = WorkerError(
                str(message.get("message", "worker error")), message.get("stack")
            )
            if self._ready and not self._ready.done():
                self._ready.set_exception(error)
            elif self._close_reason is None:
                self._close_reason = error

    def _raise_close_reason(self, error: BaseException) -> None:
        if self._close_reason is not None:
            raise self._close_reason from error
        raise error

    def _write(self, tag: int, payload: bytes) -> None:
        # Writes happen only after on_client has set the writer: bare_rpc sends
        # once a request is made, and requests wait for `ready`.
        assert self._writer is not None
        self._writer.write(_frame(tag, payload))

    async def connect(self, *, timeout: float = 30) -> BareRpcTransport:
        loop = asyncio.get_running_loop()
        self._ready = loop.create_future()
        self._exited = loop.create_future()
        self.rpc = bare_rpc.RPC(send=lambda data: self._write(_DATA, data))
        token = secrets.token_hex(32).encode("ascii")
        rejected = 0

        async def on_client(
            reader: asyncio.StreamReader, writer: asyncio.StreamWriter
        ) -> None:
            nonlocal rejected
            handshake = asyncio.current_task()
            assert handshake is not None
            self._handshakes.add(handshake)
            try:
                authenticated = await self._authenticate(reader, token)
            except asyncio.CancelledError:
                writer.close()
                raise
            finally:
                self._handshakes.discard(handshake)
            if not authenticated:
                rejected += 1
                writer.close()
                return
            if self._writer is not None:
                writer.close()
                return
            self._writer = writer
            self._read_task = asyncio.current_task()
            assert self._server is not None
            self._server.close()
            frames = _FrameReader()
            assert self.rpc is not None
            try:
                while True:
                    chunk = await reader.read(65536)
                    if not chunk:
                        break
                    for tag, payload in frames.feed(chunk):
                        if tag == _DATA:
                            await self.rpc.receive(payload)
                        elif tag == _CONTROL:
                            self._on_control(payload)
            except asyncio.CancelledError:
                # Expected on teardown: the receive pump is cancelled when the
                # transport closes. Nothing to unwind here.
                pass
            except Exception as error:
                if self._close_reason is None:
                    self._close_reason = error
                writer.close()
            finally:
                # The socket closed -- the worker exited or crashed (EOF), or we
                # are tearing down. Either way close the RPC so `_reject_all`
                # fails every pending call/stream future; otherwise a worker
                # crash leaves callers awaiting a reply that never comes.
                # Idempotent with close(), which may have already closed it.
                if self._ready and not self._ready.done():
                    self._ready.set_exception(
                        ConnectionError("worker closed before signalling ready")
                    )
                if self._exited and not self._exited.done():
                    self._exited.set_result(None)
                if self.rpc is not None:
                    self.rpc.close()

        # port=0 lets the kernel pick a free port.
        self._server = await asyncio.start_server(on_client, host="127.0.0.1", port=0)
        port = self._server.sockets[0].getsockname()[1]

        try:
            self._proc = await asyncio.create_subprocess_exec(
                *self._command,
                str(port),
                env={**os.environ, _IPC_TOKEN_ENV: token.decode("ascii")},
            )
            # A worker that cannot authenticate (or crashes on startup) exits
            # long before `timeout`; fail as soon as it does.
            exited = asyncio.ensure_future(self._proc.wait())
            waiters: set[asyncio.Future[Any]] = {self._ready, exited}
            try:
                done, _ = await asyncio.wait(
                    waiters, timeout=timeout, return_when=asyncio.FIRST_COMPLETED
                )
            finally:
                if not exited.done():
                    exited.cancel()
            if self._ready not in done:
                if self._writer is None:
                    detail = (
                        f" ({rejected} connection(s) rejected); a worker older "
                        "than this client does not send the IPC token"
                        if rejected
                        else ""
                    )
                    if exited in done:
                        raise RuntimeError(
                            f"worker exited with code {exited.result()} before "
                            f"authenticating{detail}"
                        )
                    raise asyncio.TimeoutError(
                        f"worker did not authenticate within {timeout}s{detail}"
                    )
                if exited in done:
                    raise RuntimeError(
                        f"worker exited with code {exited.result()} before "
                        "signalling ready"
                    )
                raise asyncio.TimeoutError(
                    f"worker did not signal ready within {timeout}s"
                )
            self._ready.result()
            # Hand over the home folder and SDK config before any method call,
            # mirroring the JS client's `__init_config` on connect.
            init: dict[str, Any] = {"type": "__init_config", "homeDir": self._home_dir}
            if self._config:
                init["config"] = self._config
            _json_or_raise(
                await self.rpc.request(command=0, data=json.dumps(init).encode("utf-8"))
            )
            return self
        except BaseException:
            # Spawn / connect / init-config failures must tear down the
            # loopback server bound above; otherwise the port stays open.
            await self.close()
            raise

    @staticmethod
    async def _authenticate(reader: asyncio.StreamReader, token: bytes) -> bool:
        try:
            presented = await asyncio.wait_for(
                reader.readexactly(len(token) + 1), timeout=_HANDSHAKE_TIMEOUT
            )
        except (asyncio.IncompleteReadError, asyncio.TimeoutError, OSError):
            return False
        return hmac.compare_digest(presented, token + b"\n")

    async def _process_exits(self, timeout: float) -> bool:
        assert self._proc is not None
        try:
            await asyncio.wait_for(self._proc.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            return False
        return True

    async def close(self) -> None:
        for handshake in list(self._handshakes):
            handshake.cancel()
        if (
            self._writer is not None
            and self._exited is not None
            and not self._exited.done()
            and self._proc is not None
            and self._proc.returncode is None
        ):
            self._write(_CONTROL, json.dumps({"type": "terminate"}).encode("utf-8"))
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(
                    asyncio.shield(self._exited), timeout=_TERMINATE_TIMEOUT
                )
        if self._read_task:
            self._read_task.cancel()
        if self.rpc:
            self.rpc.close()
        if self._proc and self._proc.returncode is None:
            exiting = self._exited is not None and self._exited.done()
            if not (exiting and await self._process_exits(_TERMINATE_TIMEOUT)):
                with contextlib.suppress(ProcessLookupError):
                    self._proc.kill()
                await self._proc.wait()
        if self._writer:
            self._writer.close()
        self._writer = None
        self._read_task = None
        if self._server:
            self._server.close()
            try:
                await asyncio.wait_for(self._server.wait_closed(), timeout=5)
            except asyncio.TimeoutError:
                # Best-effort close: if the server socket doesn't finish within
                # the timeout, don't block teardown on it.
                pass

    async def __aenter__(self) -> BareRpcTransport:
        return await self.connect()

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

    # ---- Transport protocol ----------------------------------------------

    def _require_rpc(self) -> Any:
        if self.rpc is None:
            raise RuntimeError("BareRpcTransport used before connect()")
        return self.rpc

    async def call(self, payload: dict) -> dict:
        """Unary, via bare_rpc.RPC.request -- no hand-rolled framing at all."""
        try:
            data = await self._require_rpc().request(
                command=0, data=json.dumps(payload).encode("utf-8")
            )
        except RuntimeError as error:
            self._raise_close_reason(error)
        return _json_or_raise(data)

    async def call_stream(self, payload: dict) -> AsyncIterator[dict]:
        """Server-stream, via bare_rpc.RPC.request_with_response_stream."""
        try:
            stream = await self._require_rpc().request_with_response_stream(
                command=0, data=json.dumps(payload).encode("utf-8")
            )
            async for value in _iter_json_lines(stream):
                yield value
        except RuntimeError as error:
            self._raise_close_reason(error)

    async def call_duplex(
        self, payload: dict, up: AsyncIterable[bytes]
    ) -> AsyncIterator[dict]:
        """Duplex, via bare_rpc.RPC.create_bidirectional_stream -- first outgoing
        chunk is the JSON payload, then `up`'s chunks; yields parsed response
        chunks with the same buffer-and-split-on-newline handling as call_stream."""
        outgoing, incoming = await self._require_rpc().create_bidirectional_stream(
            command=0
        )
        await outgoing.write(json.dumps(payload).encode("utf-8"))

        async def _pump_up() -> None:
            async for chunk in up:
                await outgoing.write(chunk)
            await outgoing.end()

        pump_task = asyncio.ensure_future(_pump_up())
        try:
            async for value in _iter_json_lines(incoming):
                yield value
        except RuntimeError as error:
            self._raise_close_reason(error)
        finally:
            if not pump_task.done():
                pump_task.cancel()
            try:
                await pump_task
            except asyncio.CancelledError:
                # Expected: pump_task was cancelled as part of close().
                pass
