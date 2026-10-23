"""Python port of packages/sdk/examples/kv-cache-example.ts.

`kv_cache=True` asks the SDK to key the cache off the conversation itself, so
a follow-up turn reprocesses only the new message. The three completions below
show the effect: the first builds the cache, the second reuses it, and the
third replays the same history with `kv_cache=False` to compare.

Read `promptTokens` to see it work — on a warm turn it counts only the tokens
the model actually processed, not the whole prompt. `cacheTokens` is what the
cache holds after the turn.

RUN: python examples/kv_cache.py
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import Client, completion, load_model, unload_model
from tetherto.qvac_sdk.models import LLAMA_3_2_1B_INST_Q4_0


async def stream_turn(run, label):
    """Print the tokens as they arrive, then the turn's stats."""
    async for event in run.events:
        if event.type == "contentDelta":
            sys.stdout.write(event.text)
            sys.stdout.flush()
    final = await run.final
    # Dumped by alias so the keys read like the JS stats object.
    stats = (
        final.stats.model_dump_json(by_alias=True, exclude_none=True)
        if final.stats
        else "{}"
    )
    print(f"\n▸ {label} stats: {stats}\n")
    return final


async def main() -> int:
    async with Client() as client:
        t = client.transport
        try:
            model_id = await load_model(
                t,
                model_src=LLAMA_3_2_1B_INST_Q4_0,
                model_config={
                    "device": "gpu",
                    "ctx_size": 2048,
                    "verbosity": 0,  # 0=ERROR, 1=WARN, 2=INFO, 3=DEBUG
                },
            )

            print("▸ Testing KV Cache functionality...\n")

            print("▸ First conversation (building cache for the next turn):")
            history1 = [{"role": "user", "content": "What is the capital of France?"}]
            run1 = completion(
                t, model_id=model_id, history=history1, stream=True, kv_cache=True
            )
            final1 = await stream_turn(run1, "First completion")

            # Continue conversation (should reuse the completed first-turn cache).
            print("▸ Continuing conversation (reusing previous turn cache):")
            history2 = [
                {"role": "user", "content": "What is the capital of France?"},
                {
                    "role": "assistant",
                    # The cacheable form drops any thinking block, so the
                    # history sent back matches what the cache was keyed on.
                    "content": final1.cacheable_assistant_content
                    or final1.content_text,
                },
                {"role": "user", "content": "What about Germany?"},
            ]

            # Auto-keyed caching should:
            # 1. Find the cache saved after turn 1 under [user, assistant]
            # 2. Load that cache and process only the new "What about Germany?" user turn
            # 3. Save the updated cache and rename it to include the new assistant response
            run2 = completion(
                t, model_id=model_id, history=history2, stream=True, kv_cache=True
            )
            await stream_turn(run2, "Second completion")

            # Compare with non-cached version
            print("▸ Same conversation without cache:")
            run3 = completion(
                t, model_id=model_id, history=history2, stream=True, kv_cache=False
            )
            await stream_turn(run3, "Non-cached completion")

            print("▸ KV Cache test completed!")

            await unload_model(t, model_id)
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
