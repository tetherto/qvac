"""Unit tests for tetherto.qvac_sdk.caller_session: the session transport stamps
every payload with the session id, holds the handle's lifecycle, records the
models loaded through it, and refuses calls locally once the session ended.
Runs against a fake transport."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterable
from typing import Any

import pytest
from conftest import FakeWorker, answer_init_config

from tetherto.qvac_sdk import _api as api
from tetherto.qvac_sdk import client as client_module
from tetherto.qvac_sdk.bare_rpc_transport import BareRpcTransport
from tetherto.qvac_sdk.caller_session import Session, open_session
from tetherto.qvac_sdk.client import Client
from tetherto.qvac_sdk.errors import (
    OWNER_HANDLE_ID,
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
    with pytest.raises(OwnerOnlyError):
        await session.transport.call({"type": "closeSession", "sessionId": "other"})
    with pytest.raises(OwnerOnlyError):
        await session.transport.call({"type": "openSession", "sessionId": "other"})
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


async def test_a_stream_read_after_the_session_ended_is_refused_locally():
    owner = FakeTransport()
    session = await open_session(owner)
    await api.load_model(
        session.transport, model_src="/models/x.gguf", model_type="llamacpp-completion"
    )
    stream = session.transport.call_stream({"type": "classify"})
    held = session.transport.call_stream({"type": "classify", "modelId": "m-1"})

    async def up():
        yield b""

    duplex = session.transport.call_duplex({"type": "transcribeStream"}, up())
    sent = len(owner.sent)

    await session.close()
    assert session.is_model_held("m-1"), "the handle still reports what it held"

    with pytest.raises(SessionInvalidatedError):
        await anext(stream)
    with pytest.raises(ModelHandleInvalidatedError) as info:
        await anext(held)
    assert info.value.model_id == "m-1"
    with pytest.raises(SessionInvalidatedError):
        await anext(duplex)
    assert len(owner.sent) == sent + 1, "only the closeSession reached the wire"


async def test_a_cancelled_close_still_closes_the_worker_session():
    class GatedClose(FakeTransport):
        def __init__(self) -> None:
            super().__init__()
            self.release = asyncio.Event()
            self.closed = False

        async def call(self, payload: dict[str, Any]) -> dict[str, Any]:
            if payload["type"] == "closeSession":
                await self.release.wait()
                self.closed = True
            return await super().call(payload)

    owner = GatedClose()
    session = await open_session(owner)
    closing = asyncio.ensure_future(session.close())
    await asyncio.sleep(0)

    closing.cancel()
    with pytest.raises(asyncio.CancelledError):
        await closing
    owner.release.set()
    for _ in range(100):
        if owner.closed:
            break
        await asyncio.sleep(0)

    assert owner.closed, "the closeSession round trip ran to its end"
    with pytest.raises(SessionInvalidatedError):
        await session.transport.call({"type": "heartbeat"})


async def test_a_session_whose_owner_shuts_down_during_the_open_is_ended():
    class ShutsDownDuringOpen(FakeTransport):
        def __init__(self) -> None:
            super().__init__()
            self.tracked: list[Any] = []

        def track_session(self, transport: Any) -> None:
            self.tracked.append(transport)

        async def call(self, payload: dict[str, Any]) -> dict[str, Any]:
            response = await super().call(payload)
            if payload["type"] == "openSession":
                # The owner closes after the reply, before the opener resumes.
                for transport in self.tracked:
                    transport.end("shutdown")
            return response

    owner = ShutsDownDuringOpen()
    session = await open_session(owner)

    with pytest.raises(SessionInvalidatedError) as info:
        await session.transport.call({"type": "heartbeat"})
    assert info.value.reason == "shutdown"


async def test_a_cancelled_open_closes_the_session_the_worker_opened():
    class GatedOpen(FakeTransport):
        def __init__(self) -> None:
            super().__init__()
            self.release = asyncio.Event()

        async def call(self, payload: dict[str, Any]) -> dict[str, Any]:
            if payload["type"] != "openSession":
                return await super().call(payload)
            # The worker has the request; its reply is held back.
            self.sent.append(payload)
            await self.release.wait()
            return {"type": "openSession", "sessionId": payload["sessionId"]}

    owner = GatedOpen()
    opening = asyncio.ensure_future(open_session(owner))
    await asyncio.sleep(0)

    opening.cancel()
    with pytest.raises(asyncio.CancelledError):
        await opening
    owner.release.set()
    for _ in range(100):
        if owner.sent and owner.sent[-1]["type"] == "closeSession":
            break
        await asyncio.sleep(0)

    opened, closed = owner.sent
    assert opened["type"] == "openSession"
    assert closed == {"type": "closeSession", "sessionId": opened["sessionId"]}


async def test_a_load_that_bypasses_the_wrappers_is_still_tracked():
    owner = FakeTransport()
    session = await open_session(owner)

    await session.transport.call(
        {"type": "loadModel", "modelSrc": "/models/x.gguf", "modelType": "llm"}
    )
    assert session.is_model_held("m-1"), "a generated-stub load is recorded"
    await session.transport.call({"type": "unloadModel", "modelId": "m-1"})
    assert not session.is_model_held("m-1"), "and its unload releases it"


async def test_the_context_manager_closes_an_open_session_once():
    owner = FakeTransport()
    async with await open_session(owner) as session:
        assert isinstance(session, Session)
    assert [p["type"] for p in owner.sent] == ["openSession", "closeSession"]

    owner = FakeTransport()
    async with await open_session(owner) as session:
        await session.close()
    assert [p["type"] for p in owner.sent] == [
        "openSession",
        "closeSession",
    ], "a session closed inside the block is not closed again on exit"


async def test_a_wrong_reply_type_is_refused():
    class WrongReply(FakeTransport):
        async def call(self, payload: dict[str, Any]) -> dict[str, Any]:
            return {"type": "heartbeat", "number": 1}

    with pytest.raises(InvalidResponseError):
        await open_session(WrongReply())


async def _answer_sessions(req) -> None:
    if await answer_init_config(req):
        return
    payload = json.loads(req.data)
    reply: dict[str, Any] = {"type": payload["type"], "success": True}
    if "sessionId" in payload:
        reply["sessionId"] = payload["sessionId"]
    if payload["type"] == "loadModel":
        reply["modelId"] = "m-1"
    if payload["type"] == "unloadModel":
        reply["hasActiveModels"] = False
    await req.reply(json.dumps(reply).encode("utf-8"))


class _FakeWorkers:
    """Stands in for the resolved worker: each start runs a new in-memory
    worker that answers the session round trips."""

    bare = None

    def __init__(self) -> None:
        self.started: list[FakeWorker] = []

    async def start(self, timeout: float, *, grace: float = 5):
        self.started.append(FakeWorker(_answer_sessions))
        return await self.started[-1].start(timeout, grace=grace)


async def _until_ended(session: Session) -> None:
    while session.transport.ended is None:
        await asyncio.sleep(0.01)


def _client_on_fake_workers(monkeypatch) -> tuple[Client, _FakeWorkers]:
    workers = _FakeWorkers()
    monkeypatch.setattr(client_module, "_resolve_worker", lambda *_: workers)
    return Client(), workers


async def test_worker_loss_ends_every_session_the_client_opened(monkeypatch):
    client, workers = _client_on_fake_workers(monkeypatch)
    await asyncio.wait_for(client.connect(), timeout=5)
    first = await client.open_session(name="first")
    second = await client.open_session(name="second")

    workers.started[-1].control("exit", code=1)
    workers.started[-1].to_host.end()
    await asyncio.wait_for(_until_ended(second), timeout=5)

    for session in (first, second):
        with pytest.raises(SessionInvalidatedError) as info:
            await asyncio.wait_for(session.transport.call({"type": "heartbeat"}), 5)
        assert info.value.reason == "crashed"

    await client.close()
    await asyncio.wait_for(client.connect(), timeout=5)
    later = await client.open_session(name="later")
    assert later.transport.ended is None, "a session on the next worker is usable"
    await client.close()


async def test_a_session_opened_on_the_transport_directly_ends_with_its_worker(
    monkeypatch,
):
    client, workers = _client_on_fake_workers(monkeypatch)
    await asyncio.wait_for(client.connect(), timeout=5)
    lost = await open_session(client.transport)

    workers.started[-1].control("exit", code=1)
    workers.started[-1].to_host.end()
    await asyncio.wait_for(_until_ended(lost), timeout=5)
    assert lost.transport.ended == "crashed"

    await client.close()
    await asyncio.wait_for(client.connect(), timeout=5)
    closed = await open_session(client.transport)
    await client.close()
    assert closed.transport.ended == "shutdown"


async def test_the_owner_close_ends_its_sessions_before_the_transport(monkeypatch):
    client, _ = _client_on_fake_workers(monkeypatch)
    await asyncio.wait_for(client.connect(), timeout=5)
    sessions = [await client.open_session(), await client.open_session()]
    ended_at_transport_close: list[str | None] = []
    close_transport = client.transport.close

    async def spy_close() -> None:
        ended_at_transport_close.extend(s.transport.ended for s in sessions)
        await close_transport()

    monkeypatch.setattr(client.transport, "close", spy_close)

    await client.close()

    assert ended_at_transport_close == ["shutdown", "shutdown"]
    with pytest.raises(SessionInvalidatedError) as info:
        await sessions[0].transport.call({"type": "heartbeat"})
    assert info.value.reason == "shutdown"


async def test_an_owner_model_is_refused_locally_after_the_runtime_stops(
    monkeypatch,
):
    client, workers = _client_on_fake_workers(monkeypatch)
    await asyncio.wait_for(client.connect(), timeout=5)
    model_id = await api.load_model(
        client.transport, model_src="/models/x.gguf", model_type="llamacpp-completion"
    )
    lost = asyncio.Event()
    client.transport.on_worker_lost(lost.set)

    workers.started[-1].control("exit", code=1)
    workers.started[-1].to_host.end()
    await asyncio.wait_for(lost.wait(), timeout=5)

    embed = {"type": "embed", "modelId": model_id, "text": "x"}
    with pytest.raises(ModelHandleInvalidatedError) as info:
        await client.transport.call(embed)
    assert info.value.model_id == model_id
    assert info.value.session_id == OWNER_HANDLE_ID

    await client.close()
    await asyncio.wait_for(client.connect(), timeout=5)
    with pytest.raises(ModelHandleInvalidatedError):
        await client.transport.call(embed)
    # These name the model without needing it loaded.
    await client.transport.call(
        {"type": "deleteCache", "modelId": model_id, "kvCacheKey": "k"}
    )
    await client.transport.call(
        {"type": "cancel", "operation": "inference", "modelId": model_id}
    )
    await client.transport.call({"type": "embed", "modelId": "m-2", "text": "x"})

    await api.load_model(
        client.transport, model_src="/models/x.gguf", model_type="llamacpp-completion"
    )
    assert (await client.transport.call(embed))["type"] == "embed"
    await client.close()


async def test_the_owner_close_invalidates_only_the_models_the_owner_still_held(
    monkeypatch,
):
    client, _ = _client_on_fake_workers(monkeypatch)
    await asyncio.wait_for(client.connect(), timeout=5)
    model_id = await api.load_model(
        client.transport, model_src="/models/x.gguf", model_type="llamacpp-completion"
    )
    await api.unload_model(client.transport, model_id)
    transport = client.transport

    await client.close()
    await asyncio.wait_for(client.connect(), timeout=5)

    reply = await transport.call({"type": "embed", "modelId": model_id, "text": "x"})
    assert reply["type"] == "embed", "an unloaded id is a plain unknown id"
    await client.close()


async def test_the_transport_reports_each_lost_worker_and_not_its_own_close(
    fake_worker,
):
    workers: list[FakeWorker] = []

    async def start(timeout: float, *, grace: float = 5):
        workers.append(fake_worker(answer_init_config))
        return await workers[-1].start(timeout, grace=grace)

    def exit_on_its_own(worker: FakeWorker) -> None:
        worker.control("exit", code=0)
        worker.to_host.end()

    transport = BareRpcTransport(start)
    lost = asyncio.Event()
    calls = 0

    def on_lost() -> None:
        nonlocal calls
        calls += 1
        lost.set()

    transport.on_worker_lost(on_lost)

    await asyncio.wait_for(transport.connect(), timeout=5)
    await asyncio.wait_for(transport.close(), timeout=5)
    await asyncio.sleep(0)
    assert calls == 0, "a worker this side closed is not a lost worker"

    await asyncio.wait_for(transport.connect(), timeout=5)
    exit_on_its_own(workers[-1])
    await asyncio.wait_for(lost.wait(), timeout=5)
    assert calls == 1

    lost.clear()
    await asyncio.wait_for(transport.connect(), timeout=5)
    exit_on_its_own(workers[-1])
    await asyncio.wait_for(lost.wait(), timeout=5)
    assert calls == 2, "a worker started by a reconnect is watched too"
    await transport.close()
