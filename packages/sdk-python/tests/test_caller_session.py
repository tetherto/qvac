"""Unit tests for tetherto.qvac_sdk.caller_session: the session transport stamps
every payload with the session id, holds the handle's lifecycle, and refuses
calls locally once the session ended. Runs against a fake transport."""

from __future__ import annotations

from collections.abc import AsyncIterable
from typing import Any

import pytest

from tetherto.qvac_sdk import _api as api
from tetherto.qvac_sdk.caller_session import Session, open_session
from tetherto.qvac_sdk.errors import (
    InvalidResponseError,
    ModelHandleInvalidatedError,
    SessionInvalidatedError,
)


class FakeTransport:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def call(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.sent.append(payload)
        kind = payload["type"]
        if kind == "openSession":
            return {
                "type": "openSession",
                "success": True,
                "sessionId": payload["sessionId"],
            }
        if kind == "closeSession":
            return {
                "type": "closeSession",
                "success": True,
                "sessionId": payload["sessionId"],
                "cancelled": 0,
                "releasedModels": [],
            }
        if kind == "cancel":
            return {"type": "cancel", "success": True, "cancelled": 0}
        if kind == "unloadModel":
            return {"type": "unloadModel", "success": True, "hasActiveModels": True}
        if kind == "heartbeat":
            return {"type": "heartbeat", "number": 1}
        return {"type": kind}

    async def call_stream(self, payload: dict[str, Any]):
        self.sent.append(payload)
        yield {"type": payload["type"], "done": True}

    async def call_duplex(self, payload: dict[str, Any], up: AsyncIterable[bytes]):
        self.sent.append(payload)
        yield {"type": payload["type"], "done": True}


async def test_open_session_registers_the_session_and_stamps_every_call():
    owner = FakeTransport()
    session = await open_session(owner, name="harness")

    assert owner.sent[0] == {
        "type": "openSession",
        "sessionId": session.session_id,
        "name": "harness",
    }
    assert session.name == "harness"

    await api.cancel(session.transport, request_id="r-1")
    assert owner.sent[-1] == {
        "type": "cancel",
        "operation": "request",
        "requestId": "r-1",
        "sessionId": session.session_id,
    }

    frames = [
        frame async for frame in session.transport.call_stream({"type": "classify"})
    ]
    assert frames == [{"type": "classify", "done": True}]
    assert owner.sent[-1] == {"type": "classify", "sessionId": session.session_id}

    async def up():
        yield b""

    frames = [
        frame
        async for frame in session.transport.call_duplex(
            {"type": "transcribeStream"}, up()
        )
    ]
    assert frames == [{"type": "transcribeStream", "done": True}]
    assert owner.sent[-1]["sessionId"] == session.session_id


async def test_a_payload_cannot_name_another_session():
    owner = FakeTransport()
    session = await open_session(owner)

    await session.transport.call({"type": "heartbeat", "sessionId": "owner"})
    assert owner.sent[-1] == {"type": "heartbeat", "sessionId": session.session_id}

    frames = [
        frame
        async for frame in session.transport.call_stream(
            {"type": "classify", "sessionId": "other"}
        )
    ]
    assert frames == [{"type": "classify", "done": True}]
    assert owner.sent[-1]["sessionId"] == session.session_id


async def test_a_session_cannot_open_a_nested_session():
    owner = FakeTransport()
    session = await open_session(owner)

    with pytest.raises(ValueError):
        await open_session(session.transport)
    assert [p["type"] for p in owner.sent] == ["openSession"]


async def test_close_sends_close_session_and_ends_the_handle():
    owner = FakeTransport()
    session = await open_session(owner)

    await session.close()

    assert owner.sent[-1] == {"type": "closeSession", "sessionId": session.session_id}
    with pytest.raises(SessionInvalidatedError) as info:
        await session.transport.call({"type": "heartbeat"})
    assert info.value.session_id == session.session_id
    assert info.value.reason == "closed"
    with pytest.raises(SessionInvalidatedError):
        await session.close()


async def test_a_held_model_names_its_own_error_after_the_session_ends():
    owner = FakeTransport()
    session = await open_session(owner)
    session.transport.record_held_model("m-1")
    assert session.is_model_held("m-1")

    session.transport.end("shutdown")

    with pytest.raises(ModelHandleInvalidatedError) as info:
        await session.transport.call({"type": "embed", "modelId": "m-1", "text": "x"})
    assert info.value.model_id == "m-1"
    with pytest.raises(SessionInvalidatedError) as other:
        await session.transport.call({"type": "embed", "modelId": "m-2", "text": "x"})
    assert other.value.reason == "shutdown"


async def test_the_context_manager_closes_an_open_session_once():
    owner = FakeTransport()
    async with await open_session(owner) as session:
        assert isinstance(session, Session)
    assert [p["type"] for p in owner.sent] == ["openSession", "closeSession"]


async def test_a_wrong_reply_type_is_refused():
    class WrongReply(FakeTransport):
        async def call(self, payload: dict[str, Any]) -> dict[str, Any]:
            return {"type": "heartbeat", "number": 1}

    with pytest.raises(InvalidResponseError):
        await open_session(WrongReply())
