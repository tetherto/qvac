"""IPC channel authentication: only the spawned worker, which knows the
per-session token, is wired to the RPC. Any other local process that dials the
loopback port is dropped without seeing or answering a frame.

Uses an in-process fake worker, so it needs no built worker and runs in the
fast PR check.
"""

from __future__ import annotations

import asyncio
import json

import bare_rpc
import pytest

from tetherto.qvac_sdk import bare_rpc_transport
from tetherto.qvac_sdk.bare_rpc_transport import BareRpcTransport

pytestmark = [pytest.mark.asyncio]


class _FakeProc:
    returncode = None

    def terminate(self) -> None:
        self.returncode = 0

    kill = terminate

    async def wait(self) -> int:
        return 0


class _Spawn:
    def __init__(self) -> None:
        self.argv: tuple = ()
        self.env: dict = {}
        self.ready = asyncio.Event()

    @property
    def port(self) -> int:
        endpoint = json.loads(self.argv[-1])["QVAC_IPC_SOCKET_PATH"]
        return int(endpoint.rsplit(":", 1)[1])

    @property
    def token(self) -> bytes:
        return self.env["QVAC_IPC_AUTH_TOKEN"].encode("ascii")


@pytest.fixture
def spawn(monkeypatch) -> _Spawn:
    captured = _Spawn()
    monkeypatch.setattr(bare_rpc_transport, "_HANDSHAKE_TIMEOUT", 0.5)

    async def fake_exec(*argv, env=None, **_kwargs):
        captured.argv = argv
        captured.env = env or {}
        captured.ready.set()
        return _FakeProc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    return captured


async def _start(transport: BareRpcTransport, spawn: _Spawn, **kwargs) -> asyncio.Task:
    task = asyncio.ensure_future(transport.connect(**kwargs))
    await asyncio.wait_for(spawn.ready.wait(), timeout=5)
    return task


async def _fake_worker(spawn: _Spawn, reply: dict, token: bytes | None = None):
    reader, writer = await asyncio.open_connection("127.0.0.1", spawn.port)
    writer.write((token if token is not None else spawn.token) + b"\n")

    async def on_request(req) -> None:
        await req.reply(json.dumps(reply).encode("utf-8"))

    rpc = bare_rpc.RPC(send=writer.write, on_request=on_request)

    async def pump() -> None:
        while chunk := await reader.read(65536):
            await rpc.receive(chunk)

    return writer, asyncio.ensure_future(pump())


def _forged_reply(request_id: int = 1) -> bytes:
    return bare_rpc.encode_response(
        request_id, data=json.dumps({"forged": True}).encode("utf-8")
    )


async def test_token_goes_in_the_environment_not_argv(spawn) -> None:
    transport = BareRpcTransport(["bare", "worker.js"])
    task = await _start(transport, spawn)
    try:
        assert len(spawn.token) == 64
        assert spawn.token.decode() not in " ".join(spawn.argv)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await transport.close()


async def test_rogue_connection_neither_sees_nor_answers_frames(spawn) -> None:
    transport = BareRpcTransport(["bare", "worker.js"])
    task = await _start(transport, spawn)

    rogue_reader, rogue_writer = await asyncio.open_connection("127.0.0.1", spawn.port)
    rogue_writer.write(_forged_reply())
    await rogue_writer.drain()

    worker_writer, pump = await _fake_worker(spawn, {"from": "worker"})
    try:
        await asyncio.wait_for(task, timeout=5)
        assert await transport.call({"type": "heartbeat"}) == {"from": "worker"}
        assert await asyncio.wait_for(rogue_reader.read(), timeout=5) == b""
    finally:
        rogue_writer.close()
        worker_writer.close()
        pump.cancel()
        await transport.close()


async def test_rogue_disconnect_does_not_close_the_rpc(spawn) -> None:
    transport = BareRpcTransport(["bare", "worker.js"])
    task = await _start(transport, spawn)

    _, rogue_writer = await asyncio.open_connection("127.0.0.1", spawn.port)
    rogue_writer.close()

    worker_writer, pump = await _fake_worker(spawn, {"from": "worker"})
    try:
        await asyncio.wait_for(task, timeout=5)
        assert await transport.call({"type": "heartbeat"}) == {"from": "worker"}
    finally:
        worker_writer.close()
        pump.cancel()
        await transport.close()


async def test_listener_closes_once_the_worker_authenticates(spawn) -> None:
    transport = BareRpcTransport(["bare", "worker.js"])
    task = await _start(transport, spawn)
    worker_writer, pump = await _fake_worker(spawn, {"from": "worker"})
    try:
        await asyncio.wait_for(task, timeout=5)
        with pytest.raises(OSError):
            await asyncio.open_connection("127.0.0.1", spawn.port)
    finally:
        worker_writer.close()
        pump.cancel()
        await transport.close()


async def test_wrong_token_is_rejected_and_connect_times_out(spawn) -> None:
    transport = BareRpcTransport(["bare", "worker.js"])
    task = await _start(transport, spawn, timeout=1)
    reader, writer = await asyncio.open_connection("127.0.0.1", spawn.port)
    writer.write(b"0" * 64 + b"\n")
    try:
        assert await asyncio.wait_for(reader.read(), timeout=5) == b""
        with pytest.raises(asyncio.TimeoutError, match="1 connection"):
            _ = await task
    finally:
        writer.close()
