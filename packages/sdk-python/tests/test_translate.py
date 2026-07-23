"""Unit tests for tetherto.qvac_sdk.api.translate: `from` passthrough (detection now lives
in the worker), the NMT no-from/to path, and the stream/non-stream handle
shapes -- against a fake transport, mirroring the JS translate coverage."""

from __future__ import annotations

from typing import Any

from tetherto.qvac_sdk import _api as api


def _chunks(tokens: list[str], stats: dict | None = None) -> list[dict]:
    out: list[dict[str, Any]] = [
        {"type": "translate", "token": token, "done": False} for token in tokens
    ]
    out.append({"type": "translate", "token": "", "done": True, "stats": stats or {}})
    return out


class FakeTransport:
    def __init__(self, stream=None):
        self.stream = stream or []
        self.sent: Any = None

    async def call(self, payload):
        raise NotImplementedError

    async def call_stream(self, payload):
        self.sent = payload
        for item in self.stream:
            yield item

    async def call_duplex(self, payload, up):
        raise NotImplementedError
        yield


# ---- translate: `from` passthrough (detection is worker-side) --------------


async def test_llm_translate_omits_from_when_absent():
    # With `from_` omitted the client sends no `from`; the worker
    # auto-detects the source language (server/bare/ops/translate.ts).
    transport = FakeTransport(stream=_chunks(["Hallo", " Welt"]))
    run = api.translate(
        transport,
        model_id="m-1",
        text="Bonjour le monde, comment allez-vous?",
        to="German",
        model_type="llm",
    )
    tokens = [token async for token in run.token_stream]
    assert tokens == ["Hallo", " Welt"]
    assert "from" not in transport.sent


async def test_llm_translate_passes_explicit_from_through():
    transport = FakeTransport(stream=_chunks(["ok"]))
    run = api.translate(
        transport,
        model_id="m-1",
        text="Bonjour le monde",
        from_="en",
        to="German",
        model_type="llamacpp-completion",
    )
    _ = [token async for token in run.token_stream]
    assert transport.sent["from"] == "en"


async def test_nmt_translate_sends_no_from():
    transport = FakeTransport(stream=_chunks(["Hola"]))
    run = api.translate(
        transport, model_id="m-1", text="Hello", model_type="nmt", stream=True
    )
    _ = [token async for token in run.token_stream]
    assert "from" not in transport.sent
    assert "to" not in transport.sent


# ---- translate: handle shapes ----------------------------------------------


async def test_stream_mode_resolves_stats_after_consumption():
    transport = FakeTransport(
        stream=_chunks(["a", "b"], stats={"totalTokens": 2, "tokensPerSecond": 10})
    )
    run = api.translate(
        transport, model_id="m-1", text="hi", model_type="nmt", stream=True
    )
    tokens = [token async for token in run.token_stream]
    assert tokens == ["a", "b"]
    stats = await run.stats
    assert stats is not None and stats.total_tokens == 2
    # Stream mode resolves text to "" (tokens came through the stream).
    assert await run.text == ""


async def test_non_stream_mode_accumulates_text_and_stats():
    transport = FakeTransport(stream=_chunks(["Hola", " mundo"], stats={}))
    run = api.translate(
        transport, model_id="m-1", text="Hello world", model_type="nmt", stream=False
    )
    assert await run.text == "Hola mundo"
    assert (await run.stats) is not None
    # Non-stream mode's token stream is empty by contract.
    assert [token async for token in run.token_stream] == []
    assert transport.sent["stream"] is False


async def test_translate_threads_request_id():
    transport = FakeTransport(stream=_chunks(["x"]))
    run = api.translate(
        transport,
        model_id="m-1",
        text="hello",
        model_type="nmt",
        request_id="req-9",
    )
    _ = [token async for token in run.token_stream]
    assert transport.sent["requestId"] == "req-9"
