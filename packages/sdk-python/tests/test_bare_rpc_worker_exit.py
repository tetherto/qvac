from __future__ import annotations

import asyncio
import json

import bare_rpc
import pytest

from tetherto.qvac_sdk import bare_rpc_transport
from tetherto.qvac_sdk.bare_rpc_transport import (
    _CONTROL,
    _DATA,
    BareRpcTransport,
    WorkerError,
    _frame,
    _FrameReader,
)

pytestmark = [pytest.mark.asyncio]


async def _start(transport: BareRpcTransport, spawn) -> asyncio.Task:
    task = asyncio.ensure_future(transport.connect())
    await asyncio.wait_for(spawn.ready.wait(), timeout=5)
    return task


async def _worker(spawn, on_request):
    reader, writer = await asyncio.open_connection("127.0.0.1", spawn.port)
    writer.write(spawn.token + b"\n")
    writer.write(_frame(_CONTROL, b'{"type":"ready"}'))
    rpc = bare_rpc.RPC(
        send=lambda data: writer.write(_frame(_DATA, data)), on_request=on_request
    )

    async def pump() -> None:
        frames = _FrameReader()
        while chunk := await reader.read(65536):
            for tag, payload in frames.feed(chunk):
                if tag == _DATA:
                    await rpc.receive(payload)

    return writer, asyncio.ensure_future(pump())


async def test_a_worker_error_after_ready_reaches_the_caller(spawn) -> None:
    transport = BareRpcTransport(["bare", "worker.js"])
    task = await _start(transport, spawn)
    writer: asyncio.StreamWriter | None = None

    async def on_request(req) -> None:
        if json.loads(req.data).get("type") == "__init_config":
            await req.reply(b'{"success":true}')
            return
        assert writer is not None
        writer.write(
            _frame(
                _CONTROL, b'{"type":"error","message":"worker blew up","stack":"at x"}'
            )
        )
        writer.write(_frame(_CONTROL, b'{"type":"exit","code":1}'))
        writer.close()

    writer, pump = await _worker(spawn, on_request)
    try:
        await asyncio.wait_for(task, timeout=5)
        with pytest.raises(WorkerError, match="worker blew up"):
            await asyncio.wait_for(transport.call({"type": "heartbeat"}), timeout=5)
        assert transport.worker_error is not None
        assert transport.worker_error.stack == "at x"
    finally:
        pump.cancel()
        await transport.close()


async def test_close_kills_a_worker_that_never_exits(spawn, monkeypatch) -> None:
    monkeypatch.setattr(bare_rpc_transport, "_TERMINATE_TIMEOUT", 0.2)
    transport = BareRpcTransport(["bare", "worker.js"])
    task = await _start(transport, spawn)

    async def on_request(req) -> None:
        await req.reply(b'{"success":true}')

    writer, pump = await _worker(spawn, on_request)
    try:
        await asyncio.wait_for(task, timeout=5)
        await asyncio.wait_for(transport.close(), timeout=2)
        assert spawn.proc is not None
        assert spawn.proc.returncode is not None
    finally:
        writer.close()
        pump.cancel()
