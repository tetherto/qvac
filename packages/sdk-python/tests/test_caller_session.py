"""Unit tests for tetherto.qvac_sdk.caller_session: the session transport stamps
every payload with the session id, holds the handle's lifecycle, records the
models loaded through it, and refuses calls locally once the session ended.
Runs against a fake transport."""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import AsyncIterable
from typing import Any

import pytest

from tetherto.qvac_sdk import _api as api
from tetherto.qvac_sdk.caller_session import Session, open_session
from tetherto.qvac_sdk.client import Client
from tetherto.qvac_sdk.errors import (
    InvalidResponseError,
    ModelHandleInvalidatedError,
    OwnerOnlyError,
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
        if kind == "loadModel":
            return {"type": "loadModel", "success": True, "modelId": "m-1"}
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


async def test_runtime_wide_operations_are_refused_on_a_session_before_the_wire():
    owner = FakeTransport()
    session = await open_session(owner)

    for kind in ("suspend", "resume", "deleteCache", "startRpcServer", "stopRpcServer"):
        with pytest.raises(OwnerOnlyError) as info:
            await session.transport.call({"type": kind})
        assert info.value.operation == kind
        assert info.value.session_id == session.session_id
    assert [p["type"] for p in owner.sent] == [
        "openSession"
    ], "nothing reached the wire"

    await session.transport.call({"type": "state"})
    assert (
        owner.sent[-1]["type"] == "state"
    ), "a read-only runtime call still goes through"


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


async def test_load_and_unload_through_a_session_track_the_held_model():
    owner = FakeTransport()
    session = await open_session(owner)
    assert not session.is_model_held("m-1")

    model_id = await api.load_model(
        session.transport, model_src="/models/x.gguf", model_type="llamacpp-completion"
    )
    assert model_id == "m-1"
    assert session.is_model_held("m-1"), "a load through the session is recorded"
    assert owner.sent[-1]["sessionId"] == session.session_id

    await api.unload_model(session.transport, "m-1")
    assert not session.is_model_held("m-1"), "an unload releases it"


async def test_a_held_model_names_its_own_error_after_the_session_ends():
    owner = FakeTransport()
    session = await open_session(owner)
    await api.load_model(
        session.transport, model_src="/models/x.gguf", model_type="llamacpp-completion"
    )
    assert session.is_model_held("m-1")

    session.transport.end("shutdown")
    assert session.is_model_held("m-1"), "the handle still reports what it held"

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


class FakeRpc:
    """Stands in for bare_rpc.RPC on an unconnected BareRpcTransport: answers
    the session round trips so Client can be driven without a worker."""

    async def request(self, *, command: int, data: bytes) -> bytes:
        payload = json.loads(data)
        return json.dumps(
            {
                "type": payload["type"],
                "success": True,
                "sessionId": payload["sessionId"],
            }
        ).encode("utf-8")

    def close(self) -> None:
        pass


def _client_without_a_worker(tmp_dir: str) -> Client:
    bare = os.path.join(tmp_dir, "bare")
    worker = os.path.join(tmp_dir, "worker.js")
    for path in (bare, worker):
        with open(path, "w", encoding="utf-8"):
            pass
    client = Client(worker_path=worker, bare_path=bare)
    client._transport.rpc = FakeRpc()  # type: ignore[assignment]
    client._connected = True
    return client


async def test_worker_loss_ends_every_session_the_client_opened():
    with tempfile.TemporaryDirectory() as tmp_dir:
        client = _client_without_a_worker(tmp_dir)
        first = await client.open_session(name="first")
        second = await client.open_session(name="second")

        client._transport._notify_worker_lost()

        for session in (first, second):
            with pytest.raises(SessionInvalidatedError) as info:
                await session.transport.call({"type": "heartbeat"})
            assert info.value.reason == "crashed"
        later = await client.open_session(name="later")
        assert later.transport.ended is None, "a session opened afterwards is usable"


async def test_the_owner_close_ends_its_sessions_before_the_transport():
    with tempfile.TemporaryDirectory() as tmp_dir:
        client = _client_without_a_worker(tmp_dir)
        session = await client.open_session()

        await client.close()

        with pytest.raises(SessionInvalidatedError) as info:
            await session.transport.call({"type": "heartbeat"})
        assert info.value.reason == "shutdown"
        client._transport._notify_worker_lost()
        assert session.transport.ended == "shutdown", "the first end reason is kept"


def test_the_transport_reports_worker_loss_once_and_not_on_its_own_close():
    from tetherto.qvac_sdk.bare_rpc_transport import BareRpcTransport

    transport = BareRpcTransport(["bare", "worker.js"])
    calls = 0

    def lost() -> None:
        nonlocal calls
        calls += 1

    transport.on_worker_lost(lost)
    transport._notify_worker_lost()
    transport._notify_worker_lost()
    assert calls == 1

    closing = BareRpcTransport(["bare", "worker.js"])
    closing.on_worker_lost(lost)
    closing._closing = True
    before = calls
    closing._notify_worker_lost()
    assert calls == before, "an EOF caused by close() is not a lost worker"
