"""Python port of packages/sdk/examples/llamacpp-sharded.ts.

Load a model distributed as multiple shards, tracking per-shard download
progress, then stream a completion against it.

Sharded models can be loaded from:
1. HTTP archives: "https://example.com/model.tar.gz"
2. HTTP pattern: "https://example.com/model-00001-of-00005.gguf"
3. Hyperdrive: use any sharded model source/constant, eg: LLAMA_3_2_1B_INST_Q4_0_SHARD
4. Local filesystem: pass the path to the first shard file (Note: All shards must
   be in the same directory)
5. Local archive: pass the path to the archive file (.tar, .tar.gz, .tgz)

RUN: python examples/sharded_models.py
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import Client, completion, load_model, unload_model


def print_progress(p) -> None:
    """Print shard download progress; pass as `on_progress=` to `load_model`."""
    # For sharded models, p.shard_info contains detailed progress for both
    # individual shards AND overall download progress across all shards
    if p.shard_info is not None:
        # For pattern-based or Hyperdrive shards. The shard counters are floats
        # on the wire, so format them as integers.
        shard_info = p.shard_info
        print(
            f"▸ Downloading {shard_info.shard_name} "
            f"({shard_info.current_shard:.0f}/{shard_info.total_shards:.0f})\n"
            f"   File: {p.percentage:.1f}% "
            f"({p.downloaded / 1024 / 1024:.2f}MB / "
            f"{p.total / 1024 / 1024:.2f}MB)\n"
            f"   Overall: {shard_info.overall_percentage:.1f}% "
            f"({shard_info.overall_downloaded / 1024 / 1024:.2f}MB / "
            f"{shard_info.overall_total / 1024 / 1024:.2f}MB)"
        )
    else:
        # For archive-based shards
        print(
            f"▸ Progress: {p.percentage:.1f}% "
            f"({p.downloaded / 1024 / 1024:.2f}MB / "
            f"{p.total / 1024 / 1024:.2f}MB)"
        )


async def main() -> int:
    async with Client() as client:
        t = client.transport
        try:
            model_id = await load_model(
                t,
                model_src=(
                    "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/"
                    "resolve/main/qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf"
                ),
                model_type="llamacpp-completion",
                model_config={
                    "device": "gpu",
                    "ctx_size": 2048,
                    "verbosity": 0,  # 0=ERROR, 1=WARN, 2=INFO, 3=DEBUG
                },
                on_progress=print_progress,
            )

            run = completion(
                t,
                model_id=model_id,
                history=[
                    {
                        "role": "user",
                        "content": (
                            "What are the benefits of sharding large language "
                            "models? Use emojis in your response."
                        ),
                    }
                ],
            )

            print("\n▸ Model response:")
            async for event in run.events:
                if event.type == "contentDelta":
                    sys.stdout.write(event.text)
                    sys.stdout.flush()

            final = await run.final
            print("\n\n▸ Performance Stats:", final.stats)

            await unload_model(t, model_id, clear_storage=False)
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
