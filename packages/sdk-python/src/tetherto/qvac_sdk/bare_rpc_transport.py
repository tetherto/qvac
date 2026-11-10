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
import json
import os
import sys
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable
from typing import Any

import bare_rpc
from bare_stow_host import IPC, WorkerError

from .errors import (
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
        self.ipc: IPC | None = None
        self.rpc: bare_rpc.RPC | None = None

    async def connect(self, *, timeout: float | None = None) -> BareRpcTransport:
        """Starts the worker and hands it the home folder, config and runtime
        context. `timeout` bounds the whole start, in seconds; it defaults to
        the config's `rpcInitTimeoutMs`, then to 60 s."""
        if timeout is None:
            timeout_ms = self._config.get("rpcInitTimeoutMs")
            timeout = (
                timeout_ms / 1000
                if isinstance(timeout_ms, int)
                else DEFAULT_START_TIMEOUT
            )
        self._closing = False
        self.ipc = None
        self.rpc = None
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        try:
            self.ipc = await self._start(timeout)
        except WorkerError as err:
            raise _startup_failed(err) from err
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
        if self.rpc is not None:
            await self.rpc.close()
        elif self.ipc is not None:
            await self.ipc.close()

    def _worker_failed(self, err: WorkerError) -> QvacError:
        if self._closing:
            return WorkerShutdownError(cause=err)
        return WorkerCrashedError(err.exit_code, err.signal_code, cause=err)

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
        try:
            data = await self._require_rpc().request(
                command=0, data=json.dumps(payload).encode("utf-8")
            )
        except WorkerError as err:
            raise self._worker_failed(err) from err
        return _json_or_raise(data)

    async def call_stream(self, payload: dict) -> AsyncIterator[dict]:
        """Server-stream, via bare_rpc.RPC.request_with_response_stream."""
        try:
            stream = await self._require_rpc().request_with_response_stream(
                command=0, data=json.dumps(payload).encode("utf-8")
            )
            async for value in _iter_json_lines(stream):
                yield value
        except WorkerError as err:
            raise self._worker_failed(err) from err

    async def call_duplex(
        self, payload: dict, up: AsyncIterable[bytes]
    ) -> AsyncIterator[dict]:
        """Duplex, via bare_rpc.RPC.create_bidirectional_stream -- first outgoing
        chunk is the JSON payload, then `up`'s chunks; yields parsed response
        chunks with the same buffer-and-split-on-newline handling as call_stream.

        When `up` raises, both directions are closed so the worker stops
        waiting for input, and the error is raised once the reply has ended."""
        try:
            outgoing, incoming = await self._require_rpc().create_bidirectional_stream(
                command=0
            )
            await outgoing.write(json.dumps(payload).encode("utf-8"))
        except WorkerError as err:
            raise self._worker_failed(err) from err

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
            async for value in _iter_json_lines(incoming):
                yield value
        except WorkerError as err:
            raise self._worker_failed(err) from err
        finally:
            if not pump_task.done():
                pump_task.cancel()
            try:
                await pump_task
            except asyncio.CancelledError:
                pass
