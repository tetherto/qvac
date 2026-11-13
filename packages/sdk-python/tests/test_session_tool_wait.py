"""Real worker: a session that closes while the worker waits for one of its
completion's client tool results.

Gated like test_conformance: needs bare_rpc and a built SDK worker.
"""

from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio
from _worker_env import WORKER, WORKER_AVAILABLE, WORKER_PATH

from tetherto.qvac_sdk import load_model
from tetherto.qvac_sdk._completion import completion_orchestrate
from tetherto.qvac_sdk.bare_rpc_transport import BareRpcTransport
from tetherto.qvac_sdk.caller_session import open_session
from tetherto.qvac_sdk.errors import InferenceCancelledError
from tetherto.qvac_sdk.models import QWEN3_600M_INST_Q4

pytestmark = [
    pytest.mark.skipif(
        not WORKER_AVAILABLE,
        reason=f"no built SDK worker (worker={WORKER_PATH!r})",
    ),
]


@pytest_asyncio.fixture
async def transport():
    async with BareRpcTransport(WORKER.start) as t:
        yield t


async def test_a_session_close_during_a_tool_call_ends_the_completion(
    transport,
) -> None:
    session = await open_session(transport)
    model_id = await load_model(
        session.transport,
        model_src=QWEN3_600M_INST_Q4,
        model_type="llamacpp-completion",
        model_config={"ctx_size": 4096, "tools": True},
    )
    tool_called = asyncio.Event()
    release_tool = asyncio.Event()

    async def get_secret_code(_arguments: dict) -> str:
        tool_called.set()
        await release_tool.wait()
        return "the secret code is 4242"

    run = completion_orchestrate(
        session.transport,
        model_id=model_id,
        history=[
            {
                "role": "user",
                "content": "Call the get_secret_code tool, then tell me the code.",
            }
        ],
        tools=[
            {
                "name": "get_secret_code",
                "description": "Returns the current secret code.",
                "parameters": {"type": "object", "properties": {}},
                "handler": get_secret_code,
            }
        ],
        generation_params={
            "temp": 0,
            "seed": 42,
            "predict": 512,
            "reasoning_budget": 0,
        },
    )
    await asyncio.wait_for(tool_called.wait(), timeout=120)

    # The client sits in the tool handler, so only the close's reply shows
    # whether the worker found the completion waiting on it.
    closed = await asyncio.wait_for(
        transport.call({"type": "closeSession", "sessionId": session.session_id}),
        timeout=30,
    )
    assert (
        closed["cancelled"] == 1
    ), "the close cancels the completion waiting on its tool"
    release_tool.set()

    with pytest.raises(InferenceCancelledError):
        await asyncio.wait_for(run.final, timeout=30)
