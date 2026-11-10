r"""Production `tetherto.qvac_sdk._transport.Transport` implementation, backed by
`bare_rpc.RPC` (github.com/holepunchto/bare-rpc-python) over the worker's
bare-stow IPC (github.com/holepunchto/bare-stow-host-python).

The IPC multiplexes the bare-rpc byte stream with bare-stow's control frames:
the worker's `ready`, `error` and `exit`, and the client's `terminate`. A worker
that fails to start raises `WorkerStartupError`; one that faults or exits while
calls are in flight fails them with `WorkerCrashedError`, and closing the
transport fails them with `WorkerShutdownError`.

Starting the worker is not this module's job -- `start` is supplied by the
caller (see `tetherto.qvac_sdk.client`).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys
import weakref
from collections.abc import (
    AsyncIterable,
    AsyncIterator,
    Awaitable,
    Callable,
    Iterator,
)
from contextlib import contextmanager
from typing import Any

import bare_rpc
from bare_stow_host import IPC, WorkerError

from ._transport import held_model_change
from .errors import (
    OWNER_HANDLE_ID,
    ModelHandleInvalidatedError,
    QvacError,
    SetConfigFailedError,
    WorkerCrashedError,
    WorkerShutdownError,
    WorkerStartupError,
    reconstruct_error,
)

__all__ = ["BareRpcTransport", "WorkerStart"]

WorkerStart = Callable[[float], Awaitable[IPC]]
"""Starts the worker and returns its IPC once it signals ready within the given
number of seconds."""

_REQUESTS_WITHOUT_MODEL_HANDLE = frozenset({"deleteCache", "cancel"})
"""Owner requests whose `modelId` does not need the model loaded: `deleteCache`
uses it only to locate cache files on disk, and a `cancel` by model on a
runtime that no longer has the model finds nothing to cancel."""

DEFAULT_START_TIMEOUT = 60.0
"""Seconds a worker gets to start, from launch until it has applied its
configuration, when neither `timeout` nor the config's `rpcInitTimeoutMs` is set."""


def _startup_failed(err: WorkerError) -> WorkerStartupError:
    timed_out = err.code == "WORKER_TIMEOUT"
    return WorkerStartupError(
        (
            "Worker did not signal ready in time"
            if timed_out
            else "Worker failed before signalling ready"
        ),
        timed_out=timed_out,
        exit_code=err.exit_code,
        signal=err.signal_code,
        cause=err,
    )


def _platform() -> str:
    if sys.platform.startswith("linux"):
        return "linux"
    return sys.platform


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
    """Starts a QVAC SDK worker with `start` and speaks to it via
    `bare_rpc.RPC`, satisfying `tetherto.qvac_sdk._transport.Transport`'s async
    call/call_stream/call_duplex shape directly.

    Closing it closes the RPC session, which terminates the worker through its
    IPC: the worker gets the grace period `start` gave it to stop, then is
    killed.
    """

    def __init__(
        self,
        start: WorkerStart,
        *,
        home_dir: str | None = None,
        config: dict[str, Any] | None = None,
    ) -> None:
        self._start = start
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
        self._closing = False
        self._starting: asyncio.Future[IPC] | None = None
        self._on_worker_lost: list[Callable[[], None]] = []
        self._watcher: asyncio.Future[None] | None = None
        # Model ids the owner loaded through this transport on the running
        # runtime, and the ones it loaded on a runtime that has since stopped.
        # An owner call naming a stopped one is refused locally until a load
        # returns that id again.
        self._owner_models: set[str] = set()
        self._invalid_owner_models: set[str] = set()
        # Sessions opened over this transport, however they were opened. They
        # end with its close and with the loss of its worker.
        self._sessions: weakref.WeakSet[Any] = weakref.WeakSet()
        self.ipc: IPC | None = None
        self.rpc: bare_rpc.RPC | None = None

    def on_worker_lost(self, callback: Callable[[], None]) -> None:
        """Registers `callback` to run each time a connected worker's RPC
        session ends on its own: the worker exited, crashed or was killed. A
        `close()` by this side does not count."""
        self._on_worker_lost.append(callback)

    def track_session(self, session: Any) -> None:
        """Ends `session` (anything with `end(reason)`) when this transport
        closes or loses its worker."""
        self._sessions.add(session)

    def _end_sessions(self, reason: str) -> None:
        for session in list(self._sessions):
            session.end(reason)
        self._sessions.clear()

    def record_held_model(self, model_id: str) -> None:
        """An owner load through this transport resolved to `model_id`."""
        self._invalid_owner_models.discard(model_id)
        self._owner_models.add(model_id)

    def release_held_model(self, model_id: str) -> None:
        """An owner unload through this transport released `model_id`."""
        self._owner_models.discard(model_id)

    def _invalidate_owner_models(self) -> None:
        self._invalid_owner_models |= self._owner_models
        self._owner_models.clear()

    def _track_owner_model(self, request: dict, response: Any) -> None:
        # Session replies are tracked by their session transport.
        if "sessionId" in request or not isinstance(response, dict):
            return
        change = held_model_change(request, response)
        if change is None:
            return
        model_id, held = change
        if held:
            self.record_held_model(model_id)
        else:
            self.release_held_model(model_id)

    def _check_owner_model(self, payload: dict) -> None:
        # Session payloads carry their session id; their session transport
        # tracks the models they load.
        if "sessionId" in payload:
            return
        if payload.get("type") in _REQUESTS_WITHOUT_MODEL_HANDLE:
            return
        model_id = payload.get("modelId")
        if isinstance(model_id, str) and model_id in self._invalid_owner_models:
            raise ModelHandleInvalidatedError(model_id, OWNER_HANDLE_ID)

    async def connect(self, *, timeout: float | None = None) -> BareRpcTransport:
        """Starts the worker and hands it the home folder, config and runtime
        context. `timeout` bounds the whole start, in seconds; it defaults to
        the config's `rpcInitTimeoutMs`, then to 60 s."""
        if timeout is None:
            timeout_ms = self._config.get("rpcInitTimeoutMs")
            timeout = (
                timeout_ms / 1000
                if isinstance(timeout_ms, (int, float))
                and not isinstance(timeout_ms, bool)
                else DEFAULT_START_TIMEOUT
            )
        self._closing = False
        self.ipc = None
        self.rpc = None
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        # Held so close() can cancel a start that has not signalled ready;
        # bare-stow-host closes the worker of a cancelled start.
        starting = asyncio.ensure_future(self._start(timeout))
        self._starting = starting
        try:
            self.ipc = await starting
        except asyncio.CancelledError as err:
            if not (self._closing and starting.cancelled()):
                raise
            raise WorkerShutdownError(cause=err) from err
        except WorkerError as err:
            raise _startup_failed(err) from err
        finally:
            self._starting = None
        if self._closing:
            await self.ipc.close()
            raise WorkerShutdownError()
        self.rpc = bare_rpc.RPC(self.ipc)
        try:
            init: dict[str, Any] = {
                "type": "__init_config",
                "homeDir": self._home_dir,
                "runtimeContext": {"platform": _platform()},
            }
            if self._config:
                init["config"] = self._config
            reply = json.loads(
                await asyncio.wait_for(
                    self.rpc.request(command=0, data=json.dumps(init).encode("utf-8")),
                    deadline - loop.time(),
                )
            )
            if not reply.get("success"):
                raise SetConfigFailedError(reply.get("error"))
            self._watcher = asyncio.ensure_future(self._watch(self.rpc))
            return self
        except asyncio.TimeoutError as err:
            await self.close()
            raise WorkerStartupError(
                "Worker did not apply its configuration in time", timed_out=True
            ) from err
        except WorkerError as err:
            await self.close()
            raise _startup_failed(err) from err
        except BaseException:
            await self.close()
            raise

    async def close(self) -> None:
        self._closing = True
        if self._starting is not None:
            self._starting.cancel()
        self._end_sessions("shutdown")
        self._invalidate_owner_models()
        if self.rpc is not None:
            await self.rpc.close()
        elif self.ipc is not None:
            await self.ipc.close()

    async def _watch(self, rpc: bare_rpc.RPC) -> None:
        # The session ends when the worker's IPC ends or fails, and when
        # close() closes it; only the first two are a lost worker. A session
        # replaced by a later connect() is no longer this transport's worker.
        with contextlib.suppress(Exception):
            await rpc.wait()
        if rpc is self.rpc:
            self._notify_worker_lost()

    def _notify_worker_lost(self) -> None:
        if self._closing:
            return
        self._end_sessions("crashed")
        self._invalidate_owner_models()
        for callback in list(self._on_worker_lost):
            callback()

    def _worker_failed(self, err: WorkerError) -> QvacError:
        if self._closing:
            return WorkerShutdownError(cause=err)
        return WorkerCrashedError(err.exit_code, err.signal_code, cause=err)

    @contextmanager
    def _session_errors(self) -> Iterator[None]:
        """Raises the SDK's error for a call that the end of the session cut
        off. bare-rpc fails calls with `CHANNEL_CLOSED` when the session ends
        without a worker fault: on `close()`, or when the worker reported its
        exit and its IPC ended, as on SIGTERM."""
        try:
            yield
        except WorkerError as err:
            raise self._worker_failed(err) from err
        except bare_rpc.RPCError as err:
            if err.code != "CHANNEL_CLOSED" or isinstance(err, bare_rpc.RPCRemoteError):
                raise
            if self._closing:
                raise WorkerShutdownError(cause=err) from err
            exit_code = self.ipc.exit_code if self.ipc is not None else None
            raise WorkerCrashedError(exit_code, cause=err) from err

    async def __aenter__(self) -> BareRpcTransport:
        return await self.connect()

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

    # ---- Transport protocol ----------------------------------------------

    def _require_rpc(self) -> bare_rpc.RPC:
        if self.rpc is None:
            raise RuntimeError("BareRpcTransport used before connect()")
        return self.rpc

    async def call(self, payload: dict) -> dict:
        """Unary, via bare_rpc.RPC.request."""
        self._check_owner_model(payload)
        with self._session_errors():
            data = await self._require_rpc().request(
                command=0, data=json.dumps(payload).encode("utf-8")
            )
        response = _json_or_raise(data)
        self._track_owner_model(payload, response)
        return response

    async def call_stream(self, payload: dict) -> AsyncIterator[dict]:
        """Server-stream, via bare_rpc.RPC.request_with_response_stream."""
        self._check_owner_model(payload)
        with self._session_errors():
            stream = await self._require_rpc().request_with_response_stream(
                command=0, data=json.dumps(payload).encode("utf-8")
            )
            async for value in _iter_json_lines(stream):
                self._track_owner_model(payload, value)
                yield value

    async def call_duplex(
        self, payload: dict, up: AsyncIterable[bytes]
    ) -> AsyncIterator[dict]:
        """Duplex, via bare_rpc.RPC.create_bidirectional_stream -- first outgoing
        chunk is the JSON payload, then `up`'s chunks; yields parsed response
        chunks with the same buffer-and-split-on-newline handling as call_stream.

        When `up` raises, both directions are closed so the worker stops
        waiting for input, and the error is raised once the reply has ended."""
        self._check_owner_model(payload)
        with self._session_errors():
            outgoing, incoming = await self._require_rpc().create_bidirectional_stream(
                command=0
            )
            await outgoing.write(json.dumps(payload).encode("utf-8"))

        async def _pump_up() -> None:
            try:
                async for chunk in up:
                    try:
                        await outgoing.write(chunk)
                    except Exception:
                        # The worker stopped reading; its reply says why.
                        return
            except BaseException:
                outgoing.destroy()
                incoming.destroy()
                raise
            await outgoing.end()

        pump_task = asyncio.ensure_future(_pump_up())
        try:
            with self._session_errors():
                async for value in _iter_json_lines(incoming):
                    yield value
        finally:
            if not pump_task.done():
                pump_task.cancel()
            try:
                await pump_task
            except asyncio.CancelledError:
                pass
