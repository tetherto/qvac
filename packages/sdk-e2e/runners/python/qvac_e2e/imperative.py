"""Hand-written bodies for the definitions that cannot be data."""

from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Awaitable, Callable
from contextlib import suppress
from typing import Any

from tetherto.qvac_sdk import (
    InferenceCancelledError,
    cancel,
    completion,
    generate_client_request_id,
)
from tetherto.qvac_sdk.methods import (
    discover_rpc_servers,
    start_rpc_server,
    stop_rpc_server,
)
from tetherto.qvac_sdk.schemas import (
    DiscoverRpcServersRequest,
    StartRpcServerRequest,
    StopRpcServerRequest,
)

from .interpreter import _START_ON_WIRE_S, _snake
from .result import StepResult
from .validation import validate

Body = Callable[[Any, dict[str, Any], dict[str, Any]], Awaitable[StepResult]]

#: Mirrors the JS body: four streams against the batch-capable model.
_CONCURRENCY = 4


async def completion_concurrent_overlap(
    resources: Any, params: dict[str, Any], expectation: dict[str, Any]
) -> StepResult:
    """Four completions decoded together, proven by the engine's own counter."""
    model_id = await resources.ensure_loaded("llm-batch")

    async def one() -> dict[str, Any]:
        run = completion(
            resources.transport,
            model_id=model_id,
            # The catalog spells params the way the wire does; this client takes keyword
            # arguments. Same translation the step interpreter applies.
            **_snake({k: v for k, v in params.items() if k != "stream"}),
            stream=True,
        )
        start = 0.0
        end = 0.0
        text = ""
        # JS reads `tokenStream`; this client exposes the typed event stream and no
        # token-only view, so the content deltas are filtered out of it. The timings are
        # what the sweep line needs, and a delta arrives when a token does either way.
        async for event in run.events:
            if getattr(event, "type", None) != "contentDelta":
                continue
            now = time.time() * 1000
            if start == 0.0:
                start = now
            end = now
            text += event.text
        stats = await run.stats()
        return {
            "start": start,
            "end": end,
            "text": text,
            "avgConcurrentSeq": getattr(stats, "avg_concurrent_seq", None),
        }

    intervals = await asyncio.gather(*(one() for _ in range(_CONCURRENCY)))

    # Sweep line over the decode intervals: peak number live at once. Ties resolve end-
    # before-start, so touching intervals do not count as overlap.
    events: list[tuple[float, int]] = []
    for item in intervals:
        events.append((item["start"], 1))
        events.append((item["end"], -1))
    events.sort(key=lambda e: (e[0], e[1]))
    live = 0
    peak_overlap = 0
    for _, delta in events:
        live += delta
        peak_overlap = max(peak_overlap, live)

    empty = sum(1 for item in intervals if not item["text"])
    if empty:
        return StepResult.fail(
            f"{empty}/{_CONCURRENCY} concurrent completions produced no output"
        )

    seqs = [item["avgConcurrentSeq"] for item in intervals]
    if not any(isinstance(s, (int, float)) for s in seqs):
        return StepResult.fail(
            "Engine did not report avgConcurrentSeq; cannot prove native concurrency"
        )
    max_seq = max((s for s in seqs if isinstance(s, (int, float))), default=0)
    if max_seq <= 1:
        return StepResult.fail(
            f"Engine avgConcurrentSeq peaked at {max_seq} (<= 1): no multi-sequence "
            f"co-residency was observed. Content-token interval peak was "
            f"{peak_overlap}/{_CONCURRENCY}."
        )

    for item in intervals:
        checked = validate(item["text"], expectation)
        if not checked.passed:
            return StepResult.fail(
                f"Concurrent completion failed expectation: {checked.output}"
            )

    return StepResult.ok(
        f"Concurrent decoding proven: engine avgConcurrentSeq peaked at "
        f"{max_seq:.2f}, client interval peak {peak_overlap}/{_CONCURRENCY}"
    )


def _unique_topic(kind: str) -> str:
    # The contract takes any 1..256 character string, so the shape is free; this is the
    # one the JS executor builds (`rpc-e2e-<kind>-<now>-<random>`), which keeps the two
    # clients' topics recognisable side by side in a worker log.
    return f"rpc-e2e-{kind}-{time.time_ns()}-{random.random()}"


async def _start_server(transport: Any, **fields: Any) -> Any:
    return await start_rpc_server(
        transport, StartRpcServerRequest(type="startRpcServer", **fields)
    )


async def _stop_server(transport: Any, server_id: str) -> None:
    await stop_rpc_server(
        transport, StopRpcServerRequest(type="stopRpcServer", server_id=server_id)
    )


async def _discover(
    transport: Any, topic: str, timeout_ms: int, request_id: str
) -> Any:
    return await discover_rpc_servers(
        transport,
        DiscoverRpcServersRequest(
            type="discoverRpcServers",
            topic=topic,
            timeout_ms=timeout_ms,
            request_id=request_id,
        ),
    )


async def _expect_error(
    work: Awaitable[Any], expectation: dict[str, Any]
) -> StepResult:
    try:
        await work
    except Exception as error:  # noqa: BLE001 - the refusal is the result
        message = str(error)
        if (
            expectation.get("validation") == "throws-error"
            and expectation.get("errorContains", "") in message
        ):
            return StepResult.ok(message)
        return StepResult.fail(message)
    return StepResult.fail("Expected an error")


async def rpc_server_lifecycle(
    resources: Any, _params: dict[str, Any], expectation: dict[str, Any]
) -> StepResult:
    """Two loopback servers with distinct ids and endpoints, each stopped."""
    transport = resources.transport
    owned: set[str] = set()
    try:
        first = await _start_server(transport)
        owned.add(first.server_id)
        second = await _start_server(transport)
        owned.add(second.server_id)
        if first.server_id == second.server_id or first.url == second.url:
            return StepResult.fail("Servers share an ID or endpoint")
        for server in (first, second):
            if (
                "runtime" in server.model_dump(by_alias=True)
                or not isinstance(server.rdma_capable, bool)
                or not server.url.startswith("127.0.0.1:")
            ):
                return StepResult.fail(
                    "Unexpected server transport or loopback default"
                )
            await _stop_server(transport, server.server_id)
            owned.discard(server.server_id)
        return validate("distinct IDs; transport reported; stop confirmed", expectation)
    finally:
        await asyncio.gather(*(_stop_server(transport, sid) for sid in owned))


async def rpc_server_empty_discovery(
    resources: Any, _params: dict[str, Any], expectation: dict[str, Any]
) -> StepResult:
    """Nothing answers on a topic nobody advertises."""
    found = await _discover(
        resources.transport, _unique_topic("empty"), 100, generate_client_request_id()
    )
    if found.servers:
        return StepResult.fail("Unexpected candidates on unique topic")
    return validate("no candidates", expectation)


async def rpc_server_unknown_stop(
    resources: Any, _params: dict[str, Any], expectation: dict[str, Any]
) -> StepResult:
    """Stopping a server this client does not own is refused."""
    return await _expect_error(
        _stop_server(resources.transport, "not-owned"), expectation
    )


async def rpc_server_unsafe_advertisement(
    resources: Any, _params: dict[str, Any], expectation: dict[str, Any]
) -> StepResult:
    """A loopback server is never advertised for discovery."""
    return await _expect_error(
        _start_server(
            resources.transport, discovery_topic="must-not-advertise-loopback"
        ),
        expectation,
    )


async def rpc_server_cancel_discovery(
    resources: Any, _params: dict[str, Any], expectation: dict[str, Any]
) -> StepResult:
    """Cancelling one discovery leaves the other to finish, and a late cancel is harmless."""
    transport = resources.transport
    topic = _unique_topic("cancel")
    selected_id = generate_client_request_id()
    other_id = generate_client_request_id()
    selected = asyncio.ensure_future(_discover(transport, topic, 30000, selected_id))
    other = asyncio.ensure_future(_discover(transport, f"{topic}-other", 100, other_id))
    try:
        # Both requests reach the worker before the cancel does.
        await asyncio.sleep(_START_ON_WIRE_S)
        await cancel(transport, request_id=selected_id)
        try:
            await selected
            return StepResult.fail("Expected typed discovery cancellation")
        except InferenceCancelledError:
            # The typed cancellation is what this step came for: swallow it and carry
            # on to the second discovery. Any other error propagates, and a discovery
            # that resolves instead is the failure returned just above.
            pass
        if (await other).servers:
            return StepResult.fail("Unexpected candidates on unique topic")
        await cancel(transport, request_id=other_id)
        return validate(
            "discovery cancelled; other discovery completed; completed cancel harmless",
            expectation,
        )
    finally:
        for request_id in (selected_id, other_id):
            with suppress(Exception):
                await cancel(transport, request_id=request_id)
        await asyncio.gather(selected, other, return_exceptions=True)


#: testId -> the body that runs it on this client.
IMPERATIVE: dict[str, Body] = {
    "completion-concurrent-overlap": completion_concurrent_overlap,
    "rpc-server-lifecycle": rpc_server_lifecycle,
    "rpc-server-empty-discovery": rpc_server_empty_discovery,
    "rpc-server-unknown-stop": rpc_server_unknown_stop,
    "rpc-server-unsafe-advertisement": rpc_server_unsafe_advertisement,
    "rpc-server-cancel-discovery": rpc_server_cancel_discovery,
}
