"""A call the caller stops, stops on the worker: bare-rpc cancels a request
whose task is cancelled, and the transport destroys a stream its reader leaves
early. Uses the in-memory fake worker, so it runs in the fast PR check.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator
from typing import cast

import pytest
from conftest import answer_init_config

from tetherto.qvac_sdk.bare_rpc_transport import BareRpcTransport

pytestmark = [pytest.mark.asyncio]


async def test_a_cancelled_call_cancels_the_request_on_the_worker(fake_worker) -> None:
    started = asyncio.Event()
    cancelled = asyncio.Event()
    codes: list[str] = []

    async def on_request(req) -> None:
        if await answer_init_config(req):
            return
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            codes.append(req.cancellation_error.code)
            cancelled.set()
            raise

    worker = fake_worker(on_request)
    transport = BareRpcTransport(worker.start)
    await asyncio.wait_for(transport.connect(), timeout=5)
    try:
        call = asyncio.ensure_future(transport.call({"type": "heartbeat"}))
        await asyncio.wait_for(started.wait(), timeout=5)

        call.cancel()

        await asyncio.wait_for(cancelled.wait(), timeout=5)
        assert codes == ["CANCELLED"]
    finally:
        await transport.close()


async def test_a_stream_left_early_stops_on_the_worker(fake_worker) -> None:
    stopped = asyncio.Event()

    async def on_request(req) -> None:
        if await answer_init_config(req):
            return
        out = await req.create_response_stream()
        line = json.dumps({"type": "loggingStream", "message": "tick"}) + "\n"
        try:
            while True:
                await out.write(line.encode("utf-8"))
                await asyncio.sleep(0.01)
        except RuntimeError:
            stopped.set()

    worker = fake_worker(on_request)
    transport = BareRpcTransport(worker.start)
    await asyncio.wait_for(transport.connect(), timeout=5)
    try:
        stream = cast(
            AsyncGenerator[dict, None],
            transport.call_stream({"type": "loggingStream", "id": "m-1"}),
        )
        assert (await anext(stream))["message"] == "tick"

        await stream.aclose()

        await asyncio.wait_for(stopped.wait(), timeout=5)
    finally:
        await transport.close()
