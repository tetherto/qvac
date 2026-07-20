"""Production `qvac._transport.Transport` implementation, backed by
`bare_rpc.RPC` (github.com/holepunchto/bare-rpc-python).

Mirrors the JS SDK's `client/rpc/node-rpc-client.ts`: create a Unix
socket / Windows named pipe, spawn the worker with that path (plus
`HOME_DIR`) as its JSON config argument, and wire `bare_rpc.RPC` to the
connection the worker dials back in on.

Locating the Bare binary and the worker's JS entry point is not this
module's job — `command` is supplied by the caller. This is a thin
client that expects the worker to be available separately; bundling
those artifacts into the installed package is a separate concern.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
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
            "(`pip install qvac[bare-rpc]`) to use BareRpcTransport"
        )


def _json_or_raise(data: bytes) -> Any:
    """Parse a JSON payload; the SDK reports failures in-band as
    {"type": "error", ...} envelopes -- rebuild the typed error (or a generic
    RPCError) so callers get `isinstance`-able classes, not strings."""
    obj = json.loads(data.decode("utf-8"))
    if isinstance(obj, dict) and obj.get("type") == "error":
        raise reconstruct_error(obj)
    return obj


class BareRpcTransport:
    """Spawns a QVAC SDK worker and speaks to it via `bare_rpc.RPC`,
    satisfying `qvac._transport.Transport`'s async call/call_stream/call_duplex
    shape directly.

    `command` is the Bare invocation up to (not including) the worker's
    JSON config argument, e.g. `["bare", "/path/to/worker.js"]` — this
    class appends `{"QVAC_IPC_SOCKET_PATH": ..., "HOME_DIR": ...}` itself,
    since that handshake is protocol, not caller, concern.
    """

    def __init__(self, command: Sequence[str], *, home_dir: str | None = None) -> None:
        if bare_rpc is None:
            raise BareRpcNotInstalledError()
        self._command = list(command)
        self._home_dir = home_dir or os.path.expanduser("~")
        self._sock_path = os.path.join(
            tempfile.gettempdir(), f"qvac-worker-{os.getpid()}-{id(self)}.sock"
        )
        self._server: asyncio.AbstractServer | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._read_task: asyncio.Task | None = None
        self.rpc: bare_rpc.RPC | None = None

    async def connect(self, *, timeout: float = 30) -> BareRpcTransport:
        if os.path.exists(self._sock_path):
            os.unlink(self._sock_path)

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
                pass

        self._server = await asyncio.start_unix_server(on_client, path=self._sock_path)

        config = json.dumps(
            {"QVAC_IPC_SOCKET_PATH": self._sock_path, "HOME_DIR": self._home_dir}
        )
        self._proc = await asyncio.create_subprocess_exec(*self._command, config)

        def send(frame: bytes) -> None:
            # bare_rpc only calls send once it has a connection, at which
            # point on_client above has already set the writer.
            assert self._writer is not None
            self._writer.write(frame)

        self.rpc = bare_rpc.RPC(send=send)
        try:
            await asyncio.wait_for(connected, timeout=timeout)
        except asyncio.TimeoutError:
            await self.close()
            raise
        return self

    async def close(self) -> None:
        if self._read_task:
            self._read_task.cancel()
        if self.rpc:
            self.rpc.close()
        if self._proc:
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
                pass
        if os.path.exists(self._sock_path):
            os.unlink(self._sock_path)

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
        buffer = ""
        async for chunk in stream:
            buffer += chunk.decode("utf-8")
            lines = buffer.split("\n")
            buffer = lines.pop()
            for line in lines:
                if line.strip():
                    yield _json_or_raise(line.encode("utf-8"))
        if buffer.strip():
            yield _json_or_raise(buffer.encode("utf-8"))

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
            buffer = ""
            async for chunk in incoming:
                buffer += chunk.decode("utf-8")
                lines = buffer.split("\n")
                buffer = lines.pop()
                for line in lines:
                    if line.strip():
                        yield _json_or_raise(line.encode("utf-8"))
            if buffer.strip():
                yield _json_or_raise(buffer.encode("utf-8"))
        finally:
            if not pump_task.done():
                pump_task.cancel()
            try:
                await pump_task
            except asyncio.CancelledError:
                pass
