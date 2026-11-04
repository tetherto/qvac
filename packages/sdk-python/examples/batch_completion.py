"""Batch completion — continuous batching over a single loaded LLM.

Python port of packages/sdk/examples/batch-completion.ts.

`batch_completion_stream` submits multiple prompts to one loaded model in a
single call, so the llama.cpp addon decodes the active sequences together. Load
the model with `parallel >= 2` to make the concurrent slots available.

Shape difference from the JS SDK: there, `batchCompletion()` returns a
`BatchCompletionRun` with a merged event stream, `byId(id)`, ordered `results`
and batch-level `stats`. Python's public surface is the frame stream underneath
that object, so this example does the grouping itself:

 - every frame carries `events`, a list of `{id, event}` records interleaved
   across prompts, where `event` is the union `completion` also streams;
 - the frame carrying `ids` gives the addon-assigned ids, in prompt order;
 - the final frame carries `stats`, one aggregate for the whole batch (e.g.
   `avg_concurrent_seq`), not one per prompt.

Each prompt may also carry `tools`, `attachments` or `responseFormat`, as in
the JS example; they are left out here to keep the run fast.

RUN: python examples/batch_completion.py
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import (
    BatchCompletionStreamRequest,
    Client,
    batch_completion_stream,
    load_model,
    unload_model,
)
from tetherto.qvac_sdk.models import LLAMA_3_2_1B_INST_Q4_0

PROMPTS = [
    {
        "id": "cherry",
        "history": [{"role": "user", "content": "Reply with only the word CHERRY."}],
        "generationParams": {"temp": 0, "seed": 42, "predict": 16},
    },
    {
        "id": "banana",
        "history": [{"role": "user", "content": "Reply with only the word BANANA."}],
        "generationParams": {"temp": 0, "seed": 42, "predict": 16},
    },
    {
        "id": "grape",
        "history": [{"role": "user", "content": "Reply with only the word GRAPE."}],
        "generationParams": {"temp": 0, "seed": 42, "predict": 16},
    },
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
        model_id = None
        try:
            # `parallel: 4` opens the concurrent decode slots batching needs.
            model_id = await load_model(
                t,
                model_src=LLAMA_3_2_1B_INST_Q4_0,
                model_config={"ctx_size": 4096, "parallel": 4},
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")

            request = BatchCompletionStreamRequest.model_validate(
                {
                    "type": "batchCompletionStream",
                    "modelId": model_id,
                    "prompts": PROMPTS,
                }
            )

            # Prompt order to start with; replaced by the addon-assigned ids
            # once the frame that carries them arrives.
            ids = [prompt["id"] for prompt in PROMPTS]
            texts: dict[str, str] = {}
            stats = None

            print("\n▸ Merged event stream (interleaved across prompts):")
            async for frame in batch_completion_stream(t, request):
                if frame.ids:
                    ids = list(frame.ids)
                for record in frame.events:
                    if record.event.type != "contentDelta":
                        continue
                    sys.stdout.write(f"[{record.id}] {record.event.text}")
                    sys.stdout.flush()
                    texts[record.id] = texts.get(record.id, "") + record.event.text
                if frame.done:
                    stats = frame.stats

            print("\n\n▸ Ordered results:")
            for prompt_id in ids:
                collapsed = " ".join(texts.get(prompt_id, "").split())
                print(f"  ▸ {prompt_id}: {collapsed}")

            # The per-prompt aggregation JS exposes as `byId(id).final` is this
            # lookup: everything collected for that one id.
            print(f'\n▸ texts["{ids[0]}"] -> {texts.get(ids[0], "").strip()}')

            # Batch-level stats: one aggregate for the whole run.
            if stats is not None and stats.tokens_per_second is not None:
                print(
                    f"\n▸ Batch stats: {stats.tokens_per_second:.1f}"
                    " tok/s across the batch"
                )
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
        finally:
            if model_id is not None:
                await unload_model(t, model_id)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
