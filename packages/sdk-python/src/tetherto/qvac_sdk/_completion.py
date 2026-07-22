"""Completion run handles + the aggregated result fold.

Ports the client half of JS's `client/api/completion-stream.ts` and
`utils/aggregate-events.ts`: `completion()` starts a completionStream call
eagerly and returns a `CompletionRun` whose canonical surfaces are `events`
(ordered typed events) and `final` (awaitable `CompletionFinal` with content,
thinking, tool calls carrying `invoke()` handlers, stats, raw text, and the
auto-cache-safe assistant string). Cancellation mirrors JS: the events stream
ends normally on a cancelled `completionDone`, while `final` rejects with
`InferenceCancelledError` carrying the partial state.

Tool handlers run client-side when the CALLER invokes them (the
`tool_call.invoke()` contract); the worker-orchestrated tool loop is the
separate `completionOrchestrate` surface.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from ._api import generate_client_request_id
from ._generated import methods as _methods
from ._transport import Transport
from .errors import CompletionFailedError, InferenceCancelledError
from .schemas import CompletionStreamRequest

ToolHandler = Callable[[dict[str, Any]], Awaitable[Any]]

_THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", re.IGNORECASE | re.DOTALL)
_UNCLOSED_TRAILING_THINK_RE = re.compile(r"<think>.*$", re.IGNORECASE | re.DOTALL)


def normalize_assistant_cache_content(content: str) -> str:
    """Canonicalize assistant text for the auto-cache key -- strip paired and
    unclosed-trailing think blocks, then trim. Byte-for-byte the same rules
    as utils/cache-normalize.ts, so pushing this string back into `history`
    keeps hitting the server's cache."""
    content = _THINK_BLOCK_RE.sub("", content)
    content = _UNCLOSED_TRAILING_THINK_RE.sub("", content)
    return content.strip()


@dataclass
class ToolCall:
    """One model-requested tool call. `invoke()` runs the caller-registered
    handler with the parsed arguments; it's None when no handler was
    registered for the tool name."""

    id: str
    name: str
    arguments: dict[str, Any]
    raw: str | None = None
    _handler: ToolHandler | None = field(default=None, repr=False)

    async def invoke(self) -> Any:
        if self._handler is None:
            raise CompletionFailedError(f"no handler registered for tool {self.name!r}")
        return await self._handler(self.arguments)

    @property
    def has_handler(self) -> bool:
        return self._handler is not None


@dataclass(frozen=True)
class CompletionFinal:
    content_text: str
    tool_calls: list[ToolCall]
    thinking_text: str | None = None
    stats: Any = None
    raw_full_text: str | None = None
    cacheable_assistant_content: str | None = None
    stop_reason: str | None = None


def _normalize_tools(
    tools: list[dict[str, Any]] | None,
) -> tuple[list[dict[str, Any]] | None, dict[str, ToolHandler]]:
    """Split caller tools into the wire shape and the handler map. Accepts
    the full wire Tool dict (optionally carrying a `handler` key, stripped
    before sending) or the simplified {name, description, parameters,
    handler?} form, which is wrapped into the wire shape."""
    if not tools:
        return None, {}
    wire_tools: list[dict[str, Any]] = []
    handlers: dict[str, ToolHandler] = {}
    for tool in tools:
        entry = dict(tool)
        handler = entry.pop("handler", None)
        if handler is not None:
            handlers[entry["name"]] = handler
        if entry.get("type") != "function":
            entry = {
                "type": "function",
                "name": entry["name"],
                "description": entry.get("description", ""),
                "parameters": entry.get(
                    "parameters", {"type": "object", "properties": {}}
                ),
            }
        wire_tools.append(entry)
    return wire_tools, handlers


def _fold_events(
    events: list[Any], handlers: dict[str, ToolHandler]
) -> tuple[CompletionFinal, str | None, bool]:
    """Port of buildFinalFromEvents: aggregate the ordered event list into a
    CompletionFinal; returns (final, error_message, cancelled)."""
    content_text = ""
    thinking_text = ""
    stats: Any = None
    raw_full_text: str | None = None
    error_message: str | None = None
    stop_reason: str | None = None
    cancelled = False
    tool_calls: list[ToolCall] = []

    for event in events:
        if event.type == "contentDelta":
            content_text += event.text
        elif event.type == "thinkingDelta":
            thinking_text += event.text
        elif event.type == "completionStats":
            stats = event.stats
        elif event.type == "toolCall":
            call = event.call
            arguments = call.arguments.root if hasattr(call.arguments, "root") else {}
            tool_calls.append(
                ToolCall(
                    id=call.id,
                    name=call.name,
                    arguments=dict(arguments),
                    raw=call.raw,
                    _handler=handlers.get(call.name),
                )
            )
        elif event.type == "completionDone":
            if event.raw is not None:
                raw_full_text = event.raw.full_text
            raw_stop = getattr(event, "stop_reason", None)
            stop_value = getattr(raw_stop, "value", raw_stop)
            # Error wins over cancelled if a wire event ever carries both:
            # a mid-stream addon failure makes partial state unsafe.
            if stop_value == "error":
                error_message = event.error.message
            else:
                if stop_value is not None:
                    stop_reason = stop_value
                if stop_value == "cancelled":
                    cancelled = True

    full_text = raw_full_text if raw_full_text is not None else content_text
    cacheable = normalize_assistant_cache_content(full_text) if not tool_calls else None
    final = CompletionFinal(
        content_text=content_text,
        thinking_text=thinking_text or None,
        tool_calls=tool_calls,
        stats=stats,
        raw_full_text=full_text,
        cacheable_assistant_content=cacheable,
        stop_reason=stop_reason,
    )
    return final, error_message, cancelled


class CompletionRun:
    """Handles for one completion call: `request_id` (usable with
    `cancel(request_id=...)` from the moment this returns), `events` (the
    ordered typed event stream), and `final` (awaitable CompletionFinal).
    `text`, `stats`, and `tool_calls` are conveniences derived from
    `final`."""

    def __init__(self, request_id: str) -> None:
        self.request_id = request_id
        loop = asyncio.get_running_loop()
        self.final: asyncio.Future[CompletionFinal] = loop.create_future()
        self._queue: asyncio.Queue[Any] = asyncio.Queue()
        self._finished = False

    async def text(self) -> str:
        return (await self.final).content_text

    async def stats(self) -> Any:
        return (await self.final).stats

    async def tool_calls(self) -> list[ToolCall]:
        return (await self.final).tool_calls

    @property
    def events(self) -> AsyncIterator[Any]:
        return self._drain()

    async def _drain(self) -> AsyncIterator[Any]:
        while True:
            item = await self._queue.get()
            if item is None:
                if not self._finished:
                    # The pump ended with an exception; surface it here too so
                    # events-only consumers see the failure, matching JS.
                    exc = self.final.exception()
                    if exc is not None and not isinstance(exc, InferenceCancelledError):
                        raise exc
                return
            yield item


def completion(
    transport: Transport,
    *,
    model_id: str,
    history: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    stream: bool = True,
    generation_params: dict[str, Any] | None = None,
    kv_cache: Any = None,
    capture_thinking: bool | None = None,
    emit_raw_deltas: bool | None = None,
    tool_dialect: str | None = None,
    response_format: dict[str, Any] | None = None,
    request_id: str | None = None,
) -> CompletionRun:
    """Start a completion and return its `CompletionRun`. The wire call
    starts eagerly (like the JS promise), so `final` resolves even if
    `events` is never consumed. Must be called with a running event loop."""
    resolved_request_id = (
        request_id if request_id is not None else generate_client_request_id()
    )
    wire_tools, handlers = _normalize_tools(tools)

    payload: dict[str, Any] = {
        "type": "completionStream",
        "modelId": model_id,
        "history": history,
        "stream": stream,
        "requestId": resolved_request_id,
    }
    if wire_tools:
        payload["tools"] = wire_tools
    if generation_params is not None:
        payload["generationParams"] = generation_params
    if kv_cache is not None:
        payload["kvCache"] = kv_cache
    if capture_thinking is not None:
        payload["captureThinking"] = capture_thinking
    if emit_raw_deltas is not None:
        payload["emitRawDeltas"] = emit_raw_deltas
    if tool_dialect is not None:
        payload["toolDialect"] = tool_dialect
    if response_format is not None:
        payload["responseFormat"] = response_format

    request = CompletionStreamRequest.model_validate(payload)
    run = CompletionRun(resolved_request_id)

    async def pump() -> None:
        all_events: list[Any] = []
        try:
            async for chunk in _methods.completion_stream(transport, request):
                for event in chunk.events:
                    all_events.append(event)
                    run._queue.put_nowait(event)
                if chunk.done:
                    final, error_message, cancelled = _fold_events(all_events, handlers)
                    if error_message is not None:
                        run.final.set_exception(CompletionFailedError(error_message))
                    elif cancelled:
                        run.final.set_exception(
                            InferenceCancelledError(
                                resolved_request_id,
                                partial_text=final.content_text,
                                partial_tool_calls=final.tool_calls,
                                partial_stats=final.stats,
                            )
                        )
                    else:
                        run.final.set_result(final)
            if not run.final.done():
                # Stream ended without a done frame: fold what arrived.
                final, error_message, _cancelled = _fold_events(all_events, handlers)
                if error_message is not None:
                    run.final.set_exception(CompletionFailedError(error_message))
                else:
                    run.final.set_result(final)
            run._finished = run.final.exception() is None or isinstance(
                run.final.exception(), InferenceCancelledError
            )
        except Exception as error:
            if not run.final.done():
                run.final.set_exception(error)
            run._finished = False
        finally:
            # final's exception is delivered via await final / events; don't
            # let an unconsumed future warn at GC time.
            if run.final.done() and run.final.exception() is not None:
                run.final.exception()
            run._queue.put_nowait(None)

    asyncio.get_running_loop().create_task(pump())
    return run


def completion_orchestrate(
    transport: Transport,
    *,
    model_id: str,
    history: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    max_tool_turns: int | None = None,
    stream: bool = True,
    generation_params: dict[str, Any] | None = None,
    capture_thinking: bool | None = None,
    tool_dialect: str | None = None,
    request_id: str | None = None,
) -> CompletionRun:
    """Worker-orchestrated completion: the WORKER runs the multi-turn tool
    loop; when the model requests a tool, the worker emits a `toolCallback`
    frame down the duplex stream, this client executes the registered
    handler and writes the result back up, and generation continues with the
    extended history. Every tool therefore needs a `handler`.

    `run.events` yields the inner completion events across every turn;
    `run.final` folds the LAST turn -- the final answer -- once the worker's
    terminal done frame arrives. Only a local worker may orchestrate: tool
    handlers execute code on this machine."""
    import json

    from .schemas import CompletionOrchestrateRequest

    resolved_request_id = (
        request_id if request_id is not None else generate_client_request_id()
    )
    wire_tools, handlers = _normalize_tools(tools)
    missing = [
        tool["name"] for tool in wire_tools or [] if tool["name"] not in handlers
    ]
    if missing:
        raise CompletionFailedError(
            f"completion_orchestrate requires a handler for every tool; missing: {missing}"
        )

    payload: dict[str, Any] = {
        "type": "completionOrchestrate",
        "modelId": model_id,
        "history": history,
        "stream": stream,
        "requestId": resolved_request_id,
    }
    if wire_tools:
        payload["tools"] = wire_tools
    if max_tool_turns is not None:
        payload["maxToolTurns"] = max_tool_turns
    if generation_params is not None:
        payload["generationParams"] = generation_params
    if capture_thinking is not None:
        payload["captureThinking"] = capture_thinking
    if tool_dialect is not None:
        payload["toolDialect"] = tool_dialect

    request = CompletionOrchestrateRequest.model_validate(payload)
    run = CompletionRun(resolved_request_id)

    upstream: asyncio.Queue[bytes | None] = asyncio.Queue()

    async def up() -> Any:
        while True:
            chunk = await upstream.get()
            if chunk is None:
                return
            yield chunk

    async def run_callback(call_id: str, name: str, arguments: dict[str, Any]) -> None:
        handler = handlers.get(name)
        try:
            if handler is None:
                raise CompletionFailedError(f"no handler registered for tool {name!r}")
            result = await handler(arguments)
            line = json.dumps({"callId": call_id, "result": result})
        except Exception as error:
            line = json.dumps({"callId": call_id, "error": str(error)})
        upstream.put_nowait(line.encode("utf-8") + b"\n")

    async def pump() -> None:
        # Events of the current turn only: `final` is the last turn's fold.
        turn_events: list[Any] = []
        current_turn = -1
        try:
            async for frame in _methods.completion_orchestrate(
                transport, request, up()
            ):
                if frame.tool_callback is not None:
                    callback = frame.tool_callback
                    arguments = (
                        callback.arguments.root
                        if hasattr(callback.arguments, "root")
                        else dict(callback.arguments)
                    )
                    await run_callback(callback.call_id, callback.name, dict(arguments))
                    continue
                if frame.events:
                    if frame.turn is not None and frame.turn != current_turn:
                        current_turn = frame.turn
                        turn_events = []
                    for event in frame.events:
                        turn_events.append(event)
                        run._queue.put_nowait(event)
                if frame.done:
                    final, error_message, cancelled = _fold_events(turn_events, {})
                    if error_message is not None:
                        run.final.set_exception(CompletionFailedError(error_message))
                    elif cancelled:
                        run.final.set_exception(
                            InferenceCancelledError(
                                resolved_request_id,
                                partial_text=final.content_text,
                                partial_stats=final.stats,
                            )
                        )
                    else:
                        run.final.set_result(final)
                    break
            if not run.final.done():
                final, error_message, _cancelled = _fold_events(turn_events, {})
                if error_message is not None:
                    run.final.set_exception(CompletionFailedError(error_message))
                else:
                    run.final.set_result(final)
            run._finished = run.final.exception() is None or isinstance(
                run.final.exception(), InferenceCancelledError
            )
        except Exception as error:
            if not run.final.done():
                run.final.set_exception(error)
            run._finished = False
        finally:
            if run.final.done() and run.final.exception() is not None:
                run.final.exception()
            upstream.put_nowait(None)
            run._queue.put_nowait(None)

    asyncio.get_running_loop().create_task(pump())
    return run


__all__ = [
    "CompletionFinal",
    "CompletionRun",
    "ToolCall",
    "completion",
    "completion_orchestrate",
    "normalize_assistant_cache_content",
]
