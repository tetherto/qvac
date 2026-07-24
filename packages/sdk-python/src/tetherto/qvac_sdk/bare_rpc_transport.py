r"""Production `tetherto.qvac_sdk._transport.Transport` implementation, backed by
`bare_rpc.RPC` (github.com/holepunchto/bare-rpc-python).

Like the JS SDK's `client/rpc/node-rpc-client.ts`, this listens for the
worker to dial back and wires `bare_rpc.RPC` to that connection. It differs
in the socket family: the Node client uses a Unix domain socket (or a
`\\.\pipe\...` named pipe on Windows), but asyncio has no cross-platform
server for either (`start_unix_server` is Unix-only). So this binds a
loopback TCP port (`127.0.0.1:0`) on every OS and hands the worker a
`tcp://127.0.0.1:<port>` endpoint. One code path everywhere, and Windows
works without a named-pipe server. The port is loopback-only; the worker is
the caller's own child process.

Locating the Bare binary and the worker's JS entry point is not this
module's job — `command` is supplied by the caller. This is a thin
client that expects the worker to be available separately; bundling
those artifacts into the installed package is a separate concern.
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterable, AsyncIterator, Sequence
from typing import Any

from .errors import reconstruct_error

try:
    import bare_rpc
except ImportError:
    bare_rpc = None

BARE_RPC_AVAILABLE = bare_rpc is not None


class BareRpcNotInstalledError(ImportError):
    def __init__(self) -> None:
        super().__init__(
            "bare_rpc is not installed -- install the 'bare-rpc' extra "
            "(`pip install tetherto-qvac-sdk[bare-rpc]`) to use BareRpcTransport"
        )


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

    `command` is the Bare invocation up to (not including) the worker's
    JSON config argument, e.g. `["bare", "/path/to/worker.js"]` — this
    class appends `{"QVAC_IPC_SOCKET_PATH": ..., "HOME_DIR": ...}` itself,
    since that handshake is protocol, not caller, concern.
    """

    def __init__(
        self,
        command: Sequence[str],
        *,
        home_dir: str | None = None,
        config: dict[str, Any] | None = None,
    ) -> None:
        if bare_rpc is None:
            raise BareRpcNotInstalledError()
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
        self.rpc: bare_rpc.RPC | None = None

    async def connect(self, *, timeout: float = 30) -> BareRpcTransport:
        connected: asyncio.Future[None] = asyncio.get_running_loop().create_future()

        async def on_client(
            reader: asyncio.StreamReader, writer: asyncio.StreamWriter
        ) -> None:
            self._writer = writer
            self._read_task = asyncio.current_task()
            if not connected.done():
                connected.set_result(None)
            # rpc is created right after the worker is spawned below, long
            # before the worker can start and dial back into this callback.
            assert self.rpc is not None
            try:
                while True:
                    chunk = await reader.read(65536)
                    if not chunk:
                        break
                    await self.rpc.receive(chunk)
            except asyncio.CancelledError:
                # Expected on teardown: the receive pump is cancelled when the
                # transport closes. Nothing to unwind here.
                pass
            finally:
                # The socket closed -- the worker exited or crashed (EOF), or we
                # are tearing down. Either way close the RPC so `_reject_all`
                # fails every pending call/stream future; otherwise a worker
                # crash leaves callers awaiting a reply that never comes.
                # Idempotent with close(), which may have already closed it.
                if self.rpc is not None:
                    self.rpc.close()

        # Loopback TCP on every OS -- see the module docstring for why this is
        # not a Unix socket. port=0 lets the kernel pick a free port.
        self._server = await asyncio.start_server(on_client, host="127.0.0.1", port=0)
        port = self._server.sockets[0].getsockname()[1]
        endpoint = f"tcp://127.0.0.1:{port}"

        spawn_config = json.dumps(
            {"QVAC_IPC_SOCKET_PATH": endpoint, "HOME_DIR": self._home_dir}
        )
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *self._command, spawn_config
            )

            def send(frame: bytes) -> None:
                # bare_rpc only calls send once it has a connection, at which
                # point on_client above has already set the writer.
                assert self._writer is not None
                self._writer.write(frame)

            self.rpc = bare_rpc.RPC(send=send)
            await asyncio.wait_for(connected, timeout=timeout)
            # Apply SDK config before any method call, mirroring the JS client's
            # `__init_config` on connect (server/rpc/handle-request.ts routes it).
            if self._config:
                _json_or_raise(
                    await self.rpc.request(
                        command=0,
                        data=json.dumps(
                            {"type": "__init_config", "config": self._config}
                        ).encode("utf-8"),
                    )
                )
            return self
        except BaseException:
            # Spawn / connect / init-config failures must tear down the
            # loopback server bound above; otherwise the port stays open.
            await self.close()
            raise

    async def close(self) -> None:
        if self._read_task:
            self._read_task.cancel()
        if self.rpc:
            self.rpc.close()
        if self._proc and self._proc.returncode is None:
            # Only signal a still-running worker: terminate()/kill() on an
            # already-exited process raises ProcessLookupError (the worker may
            # have crashed on its own before close()).
            self._proc.terminate()
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._proc.kill()
        if self._writer:
            self._writer.close()
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
        data = await self._require_rpc().request(
            command=0, data=json.dumps(payload).encode("utf-8")
        )
        return _json_or_raise(data)

    async def call_stream(self, payload: dict) -> AsyncIterator[dict]:
        """Server-stream, via bare_rpc.RPC.request_with_response_stream."""
        stream = await self._require_rpc().request_with_response_stream(
            command=0, data=json.dumps(payload).encode("utf-8")
        )
        async for value in _iter_json_lines(stream):
            yield value

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
        finally:
            if not pump_task.done():
                pump_task.cancel()
            try:
                await pump_task
            except asyncio.CancelledError:
                # Expected: pump_task was cancelled as part of close().
                pass
