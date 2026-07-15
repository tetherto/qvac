"""Smoke-tests the generated typed surface against a real running SDK worker,
via the hand-written PoC transport (poc_heartbeat.py / poc_transport.py) —
the production socket transport isn't built yet.

Needs the SDK's Bare worker built (`bun run build` in packages/sdk); defaults
to the monorepo-relative `../../sdk` (QVAC_POC_SDK_DIR overrides for an SDK
checkout elsewhere). Skipped unless a built worker is actually found there,
so it never blocks a normal `pytest` run or CI without one.

Only exercises request-reply methods that need no loaded model (`heartbeat`,
`state`) — server-stream/duplex methods need a downloaded model, which this
environment doesn't have.
"""

from __future__ import annotations

import os

import pytest
from poc_heartbeat import WORKER

pytestmark = pytest.mark.skipif(
    not os.path.exists(WORKER),
    reason=f"no built SDK worker found at {WORKER!r} -- run `bun run build` in packages/sdk, or set QVAC_POC_SDK_DIR",
)


@pytest.fixture
async def worker():
    from poc_heartbeat import QvacWorker

    async with QvacWorker() as w:
        yield w


@pytest.fixture
def transport(worker):
    from poc_transport import PocTransport

    return PocTransport(worker)


async def test_heartbeat_reply_round_trips_through_generated_stub(transport) -> None:
    from qvac.methods import heartbeat
    from qvac.schemas import HeartbeatRequest

    response = await heartbeat(transport, HeartbeatRequest(type="heartbeat"))
    assert response.type == "heartbeat"
    assert isinstance(response.number, float)


async def test_state_reply_round_trips_through_generated_stub(transport) -> None:
    from qvac.methods import state
    from qvac.schemas import StateRequest

    response = await state(transport, StateRequest(type="state"))
    assert response.type == "state"
    assert response.state is not None


async def test_model_registry_list_and_search_against_real_worker(transport) -> None:
    from qvac import api

    all_models = await api.model_registry_list(transport)
    assert len(all_models) > 0

    llm_models = await api.model_registry_search(transport, model_type="llm")
    assert len(llm_models) > 0
    assert all(model.addon.value == "llm" for model in llm_models)


async def test_delete_cache_all_against_real_worker(transport) -> None:
    from qvac import api

    result = await api.delete_cache(transport, all=True)
    assert result == {"success": True}


async def test_cancel_broad_on_unloaded_model_against_real_worker(transport) -> None:
    from qvac import api

    # A broad cancel validates the model is loaded (shared with internal
    # server-side broad cancels, per cancelHandler.ts) -- targeting a model
    # that was never loaded is a real, expected failure, not a no-op.
    with pytest.raises(api.CancelFailedError, match="not found"):
        await api.cancel(transport, model_id="no-such-model", kind="completion")
