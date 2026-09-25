"""Hand-written bodies for the definitions that cannot be data.

A step vocabulary describes what a test does to an SDK. It deliberately cannot
describe several calls in flight at once, or a cancellation racing a read --
those are properties of a language runtime, not of the SDK, and pretending
otherwise would put one runtime's concurrency model into a catalog every client
has to share.

So those tests are written per client. This is the Python half; JS has its own
under `tests/shared/executors/`. A definition with no body here still reports
`incomplete`, which is the honest state: the test applies to this client and
the client has nothing to run yet.

A body here must assert what the JS body asserts. One that settles for less --
"all four calls returned" where JS proves the engine actually decoded them
together -- turns a red cell green while the claim it stands for goes
unchecked, which is worse than the incomplete it replaced.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any

from tetherto.qvac_sdk import completion

from .interpreter import _snake
from .result import StepResult
from .validation import validate

Body = Callable[[Any, dict[str, Any], dict[str, Any]], Awaitable[StepResult]]

#: Mirrors the JS body: four streams against the batch-capable model.
_CONCURRENCY = 4


async def completion_concurrent_overlap(
    resources: Any, params: dict[str, Any], expectation: dict[str, Any]
) -> StepResult:
    """Four completions decoded together, proven by the engine's own counter.

    Mirrors `CompletionExecutor.concurrentOverlap`. Client-side interval
    overlap alone would not prove anything -- an event loop can interleave
    reads of sequentially-decoded streams -- so the assertion is the engine's
    `avgConcurrentSeq`, with the interval peak reported as the diagnostic it is
    on the JS side too.
    """
    model_id = await resources.ensure_loaded("llm-batch")

    async def one() -> dict[str, Any]:
        run = completion(
            resources.transport,
            model_id=model_id,
            # The catalog spells params the way the wire does; this client takes
            # keyword arguments. Same translation the step interpreter applies.
            **_snake({k: v for k, v in params.items() if k != "stream"}),
            stream=True,
        )
        start = 0.0
        end = 0.0
        text = ""
        # JS reads `tokenStream`; this client exposes the typed event stream and
        # no token-only view, so the content deltas are filtered out of it. The
        # timings are what the sweep line needs, and a delta arrives when a
        # token does either way.
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

    # Sweep line over the decode intervals: peak number live at once. Ties
    # resolve end-before-start, so touching intervals do not count as overlap.
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


#: testId -> the body that runs it on this client.
IMPERATIVE: dict[str, Body] = {
    "completion-concurrent-overlap": completion_concurrent_overlap,
}
