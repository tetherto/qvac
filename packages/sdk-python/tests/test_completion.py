"""Unit tests for tetherto.qvac_sdk.completion: the CompletionRun handles and the
buildFinalFromEvents fold (content/thinking aggregation, tool-call handler
attachment, cache normalization, error and cancellation contracts) over a
fake transport."""

from __future__ import annotations

from typing import Any

import pytest

from tetherto.qvac_sdk import (
    CompletionFinal,
    ToolCall,
    completion,
    normalize_assistant_cache_content,
)
from tetherto.qvac_sdk.errors import CompletionFailedError, InferenceCancelledError


class FakeTransport:
    def __init__(self, stream_items=None):
        self.stream_items = stream_items or []
        self.sent: Any = None

    async def call(self, payload):
        raise NotImplementedError

    async def call_stream(self, payload):
        self.sent = payload
        for item in self.stream_items:
            yield item

    async def call_duplex(self, payload, up):
        raise NotImplementedError
        yield


def _chunk(events: list[dict[str, Any]], done: bool = False) -> dict[str, Any]:
    return {"type": "completionStream", "events": events, "done": done}


def _delta(seq: int, text: str, type: str = "contentDelta") -> dict[str, Any]:
    return {"type": type, "seq": seq, "text": text}


def _done(seq: int, **extra: Any) -> dict[str, Any]:
    return {"type": "completionDone", "seq": seq, **extra}


# ---- cache normalization -----------------------------------------------------


def test_normalize_strips_think_blocks_and_unclosed_tail():
    assert (
        normalize_assistant_cache_content("<think>plan</think>Hello <Think>x</Think>!")
        == "Hello !"
    )
    assert normalize_assistant_cache_content("Answer.<think>oops cut of") == "Answer."
    assert normalize_assistant_cache_content("  plain  ") == "plain"


# ---- run handles ----------------------------------------------------------------


async def test_completion_aggregates_content_thinking_and_stats():
    transport = FakeTransport(
        stream_items=[
            _chunk([_delta(0, "Hel"), _delta(1, "lo")]),
            _chunk([_delta(2, " world", type="thinkingDelta")]),
            _chunk(
                [
                    {
                        "type": "completionStats",
                        "seq": 3,
                        "stats": {"generatedTokens": 5},
                    },
                    _done(
                        4,
                        stopReason="eos",
                        raw={"fullText": "<think> world</think>Hello"},
                    ),
                ],
                done=True,
            ),
        ]
    )
    run = completion(
        transport, model_id="m-1", history=[{"role": "user", "content": "hi"}]
    )
    events = [event async for event in run.events]
    assert [event.type for event in events] == [
        "contentDelta",
        "contentDelta",
        "thinkingDelta",
        "completionStats",
        "completionDone",
    ]
    final = await run.final
    assert isinstance(final, CompletionFinal)
    assert final.content_text == "Hello"
    assert final.thinking_text == " world"
    assert final.stats.generated_tokens == 5
    assert final.raw_full_text == "<think> world</think>Hello"
    # Cache string strips the think block out of the raw text.
    assert final.cacheable_assistant_content == "Hello"
    assert final.stop_reason == "eos"
    assert await run.text() == "Hello"
    assert transport.sent["requestId"] == run.request_id


async def test_tool_calls_get_invokable_handlers_and_no_cache_content():
    async def lookup(args: dict[str, Any]) -> Any:
        return {"temp": 22, "city": args["city"]}

    transport = FakeTransport(
        stream_items=[
            _chunk(
                [
                    {
                        "type": "toolCall",
                        "seq": 0,
                        "call": {
                            "id": "call-1",
                            "name": "get_weather",
                            "arguments": {"city": "Tokyo"},
                        },
                    },
                    _done(1, stopReason="eos"),
                ],
                done=True,
            )
        ]
    )
    run = completion(
        transport,
        model_id="m-1",
        history=[{"role": "user", "content": "weather?"}],
        tools=[
            {
                "name": "get_weather",
                "description": "Get current weather",
                "parameters": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                },
                "handler": lookup,
            }
        ],
    )
    final = await run.final
    assert len(final.tool_calls) == 1
    call = final.tool_calls[0]
    assert isinstance(call, ToolCall)
    assert call.name == "get_weather" and call.arguments == {"city": "Tokyo"}
    assert call.has_handler
    assert await call.invoke() == {"temp": 22, "city": "Tokyo"}
    # Tool-call turns can't be auto-cached.
    assert final.cacheable_assistant_content is None
    # The wire tools were sent in full Tool shape without the handler.
    sent_tool = transport.sent["tools"][0]
    assert sent_tool["type"] == "function"
    assert "handler" not in sent_tool


async def test_error_done_rejects_final_and_events_raise():
    transport = FakeTransport(
        stream_items=[
            _chunk(
                [_done(0, stopReason="error", error={"message": "addon exploded"})],
                done=True,
            )
        ]
    )
    run = completion(
        transport, model_id="m-1", history=[{"role": "user", "content": "x"}]
    )
    with pytest.raises(CompletionFailedError, match="addon exploded"):
        _ = [event async for event in run.events]
    with pytest.raises(CompletionFailedError):
        await run.final


async def test_cancelled_done_ends_events_normally_but_rejects_final():
    transport = FakeTransport(
        stream_items=[
            _chunk([_delta(0, "partial ")]),
            _chunk([_done(1, stopReason="cancelled")], done=True),
        ]
    )
    run = completion(
        transport, model_id="m-1", history=[{"role": "user", "content": "x"}]
    )
    events = [event async for event in run.events]
    # Events end normally: the consumer sees the cancelled completionDone.
    assert events[-1].type == "completionDone"
    with pytest.raises(InferenceCancelledError) as excinfo:
        await run.final
    assert excinfo.value.partial_text == "partial "
    assert excinfo.value.request_id == run.request_id


async def test_final_resolves_even_when_events_never_consumed():
    transport = FakeTransport(
        stream_items=[_chunk([_delta(0, "hi"), _done(1, stopReason="eos")], done=True)]
    )
    run = completion(
        transport, model_id="m-1", history=[{"role": "user", "content": "x"}]
    )
    final = await run.final
    assert final.content_text == "hi"


async def test_invoke_without_handler_raises():
    call = ToolCall(id="c", name="ghost", arguments={})
    assert not call.has_handler
    with pytest.raises(CompletionFailedError, match="no handler"):
        await call.invoke()


# ---- worker-orchestrated completion --------------------------------------------


def _orch(**fields: Any) -> dict[str, Any]:
    return {"type": "completionOrchestrate", **fields}


class OrchestratingFakeTransport:
    """Plays the worker's side of the tool loop: emits a turn-0 tool call,
    asks for the callback, waits for the client's upstream result line, then
    produces the final answer turn."""

    def __init__(self):
        self.sent: Any = None
        self.received: list[dict[str, Any]] = []

    async def call(self, payload):
        raise NotImplementedError

    async def call_stream(self, payload):
        raise NotImplementedError
        yield

    async def call_duplex(self, payload, up):
        import json

        self.sent = payload
        up_iter = aiter(up)
        yield _orch(
            turn=0,
            events=[
                {
                    "type": "toolCall",
                    "seq": 0,
                    "call": {
                        "id": "call-1",
                        "name": "get_weather",
                        "arguments": {"city": "Tokyo"},
                    },
                },
                _done(1, stopReason="eos", raw={"fullText": "<call get_weather>"}),
            ],
        )
        yield _orch(
            turn=0,
            toolCallback={
                "callId": "call-1",
                "name": "get_weather",
                "arguments": {"city": "Tokyo"},
            },
        )
        self.received.append(json.loads(await anext(up_iter)))
        yield _orch(
            turn=1,
            events=[
                _delta(0, "22C."),
                _done(1, stopReason="eos", raw={"fullText": "22C."}),
            ],
        )
        yield _orch(done=True)


WEATHER_TOOL = {
    "name": "get_weather",
    "description": "Get current weather",
    "parameters": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"],
    },
}


async def test_orchestrate_runs_handler_and_folds_final_turn():
    from tetherto.qvac_sdk._completion import completion_orchestrate

    seen_args: list[dict[str, Any]] = []

    async def handler(args: dict[str, Any]) -> Any:
        seen_args.append(args)
        return {"temp": 22}

    transport = OrchestratingFakeTransport()
    run = completion_orchestrate(
        transport,
        model_id="m-1",
        history=[{"role": "user", "content": "weather in Tokyo?"}],
        tools=[{**WEATHER_TOOL, "handler": handler}],
    )
    events = [event async for event in run.events]
    final = await run.final

    assert seen_args == [{"city": "Tokyo"}]
    assert transport.received == [{"callId": "call-1", "result": {"temp": 22}}]
    # Events surface every turn; final folds only the last (the answer).
    assert any(event.type == "toolCall" for event in events)
    assert final.content_text == "22C."
    assert final.tool_calls == []
    assert transport.sent["tools"][0]["name"] == "get_weather"
    assert "handler" not in transport.sent["tools"][0]


async def test_orchestrate_handler_error_is_reported_upstream():
    from tetherto.qvac_sdk._completion import completion_orchestrate

    async def handler(args: dict[str, Any]) -> Any:
        raise RuntimeError("api down")

    transport = OrchestratingFakeTransport()
    run = completion_orchestrate(
        transport,
        model_id="m-1",
        history=[{"role": "user", "content": "weather?"}],
        tools=[{**WEATHER_TOOL, "handler": handler}],
    )
    final = await run.final
    assert transport.received == [{"callId": "call-1", "error": "api down"}]
    assert final.content_text == "22C."


async def test_orchestrate_requires_handlers_for_every_tool():
    from tetherto.qvac_sdk._completion import completion_orchestrate

    with pytest.raises(CompletionFailedError, match="missing.*get_weather"):
        completion_orchestrate(
            OrchestratingFakeTransport(),
            model_id="m-1",
            history=[{"role": "user", "content": "x"}],
            tools=[WEATHER_TOOL],
        )
