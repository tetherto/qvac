"""Deadlines the runtime enforces: `with_deadline` puts them on the requests
it sends, and the worker's `DEADLINE_EXCEEDED` error comes back typed. The
last test runs a real worker whose only plugin stalls."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterable
from pathlib import Path
from typing import Any

import pytest
from _worker_env import _HARNESS, SDK_DIR, WORKER_AVAILABLE

from tetherto.qvac_sdk import _api as api
from tetherto.qvac_sdk.caller_session import open_session
from tetherto.qvac_sdk.client import Client
from tetherto.qvac_sdk.deadlines import UNTRACKED_REQUEST_TYPES, with_deadline
from tetherto.qvac_sdk.errors import DeadlineExceededError, reconstruct_error

CONTRACT_DIR = Path(SDK_DIR) / "contract"
STALL_WORKER = Path(SDK_DIR) / "test" / "fixtures" / "stall-worker.mjs"


class RecordingTransport:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def call(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.sent.append(payload)
        if payload["type"] == "openSession":
            return {
                "type": "openSession",
                "success": True,
                "sessionId": payload["sessionId"],
            }
        if payload["type"] == "pluginInvoke":
            return {"type": "pluginInvoke", "result": None}
        return {"type": payload["type"]}

    async def call_stream(self, payload: dict[str, Any]):
        self.sent.append(payload)
        yield {"type": payload["type"], "done": True}

    async def call_duplex(self, payload: dict[str, Any], up: AsyncIterable[bytes]):
        self.sent.append(payload)
        yield {"type": payload["type"], "done": True}


def test_deadline_exceeded_reconstructs_its_boundary_and_limit():
    err = reconstruct_error(
        {
            "type": "error",
            "message": 'Request "req-1" exceeded its idle deadline of 60000ms',
            "name": "DEADLINE_EXCEEDED",
            "code": 52425,
            "typedFields": {
                "requestId": "req-1",
                "boundary": "idle",
                "timeoutMs": 60000,
                "capability": "completion",
                "modelId": "m-1",
            },
        }
    )
    assert isinstance(err, DeadlineExceededError)
    assert (err.request_id, err.boundary, err.timeout_ms) == ("req-1", "idle", 60000)
    assert (err.capability, err.model_id) == ("completion", "m-1")
    assert err.code == 52425


def test_deadline_exceeded_for_a_load_has_no_capability_or_model():
    err = reconstruct_error(
        {
            "type": "error",
            "message": "load deadline",
            "name": "DEADLINE_EXCEEDED",
            "typedFields": {
                "requestId": "req-2",
                "boundary": "load",
                "timeoutMs": 300000,
            },
        }
    )
    assert isinstance(err, DeadlineExceededError)
    assert (err.boundary, err.capability, err.model_id) == ("load", None, None)


async def test_with_deadline_stamps_unary_stream_and_duplex_requests():
    inner = RecordingTransport()
    bounded = with_deadline(inner, queue_ms=10_000, idle_ms=90_000)
    deadline = {"queueMs": 10_000, "idleMs": 90_000}

    await bounded.call({"type": "embed", "modelId": "m"})
    async for _ in bounded.call_stream({"type": "completionStream", "modelId": "m"}):
        pass

    async def no_input():
        return
        yield b""

    async for _ in bounded.call_duplex(
        {"type": "transcribeStream", "modelId": "m"}, no_input()
    ):
        pass

    assert [payload["deadline"] for payload in inner.sent] == [deadline] * 3


async def test_with_deadline_leaves_requests_that_register_no_work_alone():
    inner = RecordingTransport()
    bounded = with_deadline(inner, run_ms=5_000)

    await bounded.call({"type": "cancel", "operation": "request", "requestId": "r"})
    await bounded.call({"type": "heartbeat"})

    assert all("deadline" not in payload for payload in inner.sent)


async def test_a_request_that_carries_its_own_deadline_keeps_it():
    inner = RecordingTransport()
    bounded = with_deadline(inner, run_ms=5_000)

    await bounded.call({"type": "embed", "modelId": "m", "deadline": {"runMs": 100}})

    assert inner.sent[0]["deadline"] == {"runMs": 100}


async def test_with_deadline_over_a_session_keeps_the_session_id():
    owner = RecordingTransport()
    session = await open_session(owner, name="harness")
    bounded = with_deadline(session.transport, queue_ms=1_000)

    await api.invoke_plugin(bounded, "m", "handler", {})

    sent = owner.sent[-1]
    assert sent["sessionId"] == session.session_id
    assert sent["deadline"] == {"queueMs": 1_000}
    assert bounded.session_id == session.session_id


@pytest.mark.parametrize("value", [0, -1, 1.5, True])
def test_with_deadline_refuses_a_value_that_is_not_a_positive_integer(value):
    with pytest.raises(ValueError, match="idleMs"):
        with_deadline(RecordingTransport(), idle_ms=value)


def _takes_deadline(schema: dict[str, Any]) -> bool:
    arms = schema.get("oneOf") or schema.get("anyOf")
    if arms:
        return any(_takes_deadline(arm) for arm in arms)
    return "deadline" in schema.get("properties", {})


@pytest.mark.skipif(
    not (CONTRACT_DIR / "schema.json").exists(), reason="no @qvac/sdk checkout"
)
def test_the_untracked_request_types_match_the_contract():
    schema = json.loads((CONTRACT_DIR / "schema.json").read_text(encoding="utf-8"))
    manifest = json.loads((CONTRACT_DIR / "manifest.json").read_text(encoding="utf-8"))
    without_deadline = {
        method["name"]
        for method in manifest["methods"]
        if not _takes_deadline(schema["$defs"][f"{method['name']}.request"])
    }
    assert without_deadline == set(UNTRACKED_REQUEST_TYPES)


@pytest.mark.skipif(
    _HARNESS is not None or not WORKER_AVAILABLE or not STALL_WORKER.exists(),
    reason="needs the built @qvac/sdk checkout to run the stall worker fixture",
)
async def test_a_real_worker_fails_a_stalled_call_at_its_deadline(tmp_path) -> None:
    model_path = tmp_path / "model.bin"
    model_path.write_bytes(b"")

    async with Client(worker_path=str(STALL_WORKER), sdk_dir=SDK_DIR) as client:
        model_id = await api.load_model(
            client.transport,
            model_src=str(model_path),
            model_type="deadline-stall-test",
        )

        idle = with_deadline(client.transport, idle_ms=300)
        chunks = api.invoke_plugin_stream(idle, model_id, "stall", {})
        assert (await anext(chunks))["n"] == 1
        with pytest.raises(DeadlineExceededError) as stalled:
            await asyncio.wait_for(anext(chunks), timeout=20)
        assert stalled.value.boundary == "idle"
        assert stalled.value.timeout_ms == 300
        assert stalled.value.model_id == model_id

        ignoring = api.invoke_plugin_stream(
            idle, model_id, "stallIgnoringAbort", {"key": "stream"}
        )
        await anext(ignoring)
        with pytest.raises(DeadlineExceededError) as ignored:
            await asyncio.wait_for(anext(ignoring), timeout=20)
        assert ignored.value.boundary == "idle"

        started = time.monotonic()
        with pytest.raises(DeadlineExceededError) as hung:
            await api.invoke_plugin(
                with_deadline(client.transport, run_ms=300),
                model_id,
                "hang",
                {"key": "reply"},
            )
        assert hung.value.boundary == "run"
        assert time.monotonic() - started < 5

        for key in ("stream", "reply"):
            await api.invoke_plugin(client.transport, model_id, "release", {"key": key})
