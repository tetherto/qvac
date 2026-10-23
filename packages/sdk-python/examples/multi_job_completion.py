"""Python port of packages/sdk/examples/multi-job-completion.ts.

Multi-job continuous batching — concurrent completions on one loaded LLM.

Unlike `batch_completion_stream` (which bundles many prompts into ONE call),
this shows independent `completion()` calls fired concurrently against the SAME
loaded model. When the model is loaded with `model_config["parallel"] >= 2`, the
SDK admits up to `parallel` completions at once and the llama.cpp addon decodes
their sequences together — so a burst of prompts finishes in roughly the time
of the slowest one, not the sum of all of them.

Each `completion()` returns an independent `CompletionRun`:
 - `events`     — an async iterator of streamed events for that call.
 - `final`      — an awaitable `CompletionFinal` with THIS call's own
                  `content_text` and `stats` (its own tokens/sec, TTFT).
                  `stats.avg_concurrent_seq` stays model-level (how busy the
                  shared backend was).
 - `request_id` — cancel just this call with `cancel(request_id=...)`; peers
                  keep decoding.

Completions and batches share the model's `parallel` admission cap: with
`parallel` in flight, admitting one more waits FIFO until a slot frees.

RUN: python examples/multi_job_completion.py
"""

from __future__ import annotations

import asyncio
import sys
import time

from tetherto.qvac_sdk import (
    Client,
    InferenceCancelledError,
    cancel,
    completion,
    load_model,
    unload_model,
)
from tetherto.qvac_sdk.models import LLAMA_3_2_1B_INST_Q4_0

PROMPTS = [
    ("cherry", "Reply with only the word CHERRY."),
    ("banana", "Reply with only the word BANANA."),
    ("grape", "Reply with only the word GRAPE."),
    ("lemon", "Reply with only the word LEMON."),
]


def print_progress(p) -> None:
    """Print model download progress; pass as `on_progress=` to `load_model`."""
    line = (
        f"▸ Downloading {p.percentage:.0f}% "
        f"({p.downloaded / 1e6:.1f}/{p.total / 1e6:.1f} MB)"
    )
    print(line, end="\r" if sys.stderr.isatty() else "\n", file=sys.stderr)
    if p.percentage >= 100:
        print(file=sys.stderr)


async def main() -> int:
    async with Client() as client:
        t = client.transport
        try:
            # `parallel: 4` opens the concurrent decode slots continuous
            # batching needs.
            model_id = await load_model(
                t,
                model_src=LLAMA_3_2_1B_INST_Q4_0,
                model_config={"ctx_size": 4096, "parallel": 4},
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")

            # ---- Concurrent completions. Fire every call before awaiting any,
            # so all four are admitted and decode together (not
            # one-after-another). ----
            print("\n▸ Firing 4 completions concurrently:")
            started = time.monotonic()
            runs = [
                completion(
                    t,
                    model_id=model_id,
                    history=[{"role": "user", "content": ask}],
                    generation_params={"temp": 0, "seed": 42, "predict": 16},
                )
                for _name, ask in PROMPTS
            ]

            finals = await asyncio.gather(*(run.final for run in runs))
            elapsed_ms = (time.monotonic() - started) * 1000

            outputs = [
                (name, " ".join(final.content_text.split()), final.stats)
                for (name, _ask), final in zip(PROMPTS, finals)
            ]

            for name, text, stats in outputs:
                tokens_per_second = getattr(stats, "tokens_per_second", None)
                tps = (
                    f"{tokens_per_second:.1f}"
                    if tokens_per_second is not None
                    else "n/a"
                )
                print(f'  ▸ {name}: "{text}"  (own {tps} tok/s)')

            # Report the engine's own measure of overlap rather than inferring it
            # from wall-clock: avg_concurrent_seq > 1 means the addon decoded
            # sequences together.
            peak_concurrent = max(
                getattr(stats, "avg_concurrent_seq", None) or 0
                for _name, _text, stats in outputs
            )
            print(
                f"\n▸ All 4 finished in {elapsed_ms:.0f} ms; engine avg concurrent "
                f"sequences: {peak_concurrent:.1f} (> 1 = decoded together)."
            )

            # ---- Per-request cancel isolation. Fire two long runs; cancel only
            # the first by its request_id. The second must keep decoding past
            # the cancel. ----
            print(
                "\n▸ Per-request cancel: cancelling one of two in-flight completions:"
            )
            doomed = completion(
                t,
                model_id=model_id,
                history=[
                    {"role": "user", "content": "Write a long story about an otter."}
                ],
                generation_params={"temp": 0, "seed": 1, "predict": 256},
            )
            survivor = completion(
                t,
                model_id=model_id,
                history=[
                    {"role": "user", "content": "Write a long story about a melon."}
                ],
                generation_params={"temp": 0, "seed": 42, "predict": 256},
            )

            # Bind each stream once: `run.events` returns a NEW iterator per
            # access and every one of them drains the same queue, so reading the
            # property twice would split a run's events between two iterators.
            # Holding the survivor's iterator also lets us count what it emits
            # AFTER the cancel is acknowledged — a short survivor could
            # otherwise finish before the cancel lands and pass even under a
            # model-wide cancel.
            doomed_events = doomed.events
            survivor_events = survivor.events

            # Wait until BOTH runs are actually streaming before cancelling, so
            # the cancel hits a genuinely in-flight peer, not a pre-admission
            # drop.
            await asyncio.gather(anext(doomed_events), anext(survivor_events))

            await cancel(t, request_id=doomed.request_id)

            doomed_cancelled = False
            try:
                await doomed.final
            except Exception as error:
                doomed_cancelled = isinstance(error, InferenceCancelledError)

            # Drain what the survivor emits from here on: a per-request cancel
            # leaves it decoding to completion, a model-wide cancel would have
            # stopped it.
            tokens_after_cancel = 0
            async for _event in survivor_events:
                tokens_after_cancel += 1

            survivor_final = await survivor.final
            survivor_text = " ".join(survivor_final.content_text.split())
            state = "cancelled" if doomed_cancelled else "NOT cancelled"
            print(f"  ▸ cancelled run -> {state}")
            print(
                f"  ▸ peer kept decoding -> +{tokens_after_cancel} tokens after "
                f"the cancel ack"
            )

            await unload_model(t, model_id)

            # A zero exit must prove concurrent scheduling, typed cancellation,
            # and survivor isolation: the first burst reported multiple resident
            # sequences, the doomed run cancelled, and its peer produced tokens
            # AFTER the cancel landed.
            if (
                peak_concurrent <= 1
                or not doomed_cancelled
                or tokens_after_cancel == 0
            ):
                print(
                    f"✖ multi-job behavior not demonstrated "
                    f"(peak_concurrent={peak_concurrent:.2f}, "
                    f"doomed_cancelled={doomed_cancelled}, "
                    f"tokens_after_cancel={tokens_after_cancel}, "
                    f'survivor_text="{survivor_text}")',
                    file=sys.stderr,
                )
                return 1
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
