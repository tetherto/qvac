"""Python port of packages/sdk/examples/assess-model-fit.ts.

Which models fit this machine, asked before downloading any weights. Each
engine's fitter reads the registry's weightless description of a model, so
nothing is fetched beyond tens of KB, loaded or reserved.

Each model gets its own verdict and the memory it takes on each device, and
the set gets one verdict for all of them loaded together, with what it takes
from each memory pool. `unknown` is a valid answer: show it as "can't say",
never as "no".

RUN: python examples/assess_model_fit.py
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import Client, assess_model_fit
from tetherto.qvac_sdk.models import (
    QWEN3_1_7B_INST_Q4,
    QWEN3_4B_INST_Q4_K_M,
    QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL,
    QWEN3_8B_INST_Q4_K_M,
    QWEN3_600M_INST_Q4,
)

# The fitter sizes the load as `load_model` would run it, context included.
CONTEXT_TOKENS = 8192

# A ladder ending well past what a laptop has, so one screen shows every verdict.
CANDIDATES = [
    QWEN3_600M_INST_Q4,
    QWEN3_1_7B_INST_Q4,
    QWEN3_4B_INST_Q4_K_M,
    QWEN3_8B_INST_Q4_K_M,
    QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL,
]

VERDICT_MARK = {"fits": "✔", "does-not-fit": "✖", "unknown": "?"}


def gib(byte_count: float) -> str:
    return f"{byte_count / 1024**3:.2f} GiB"


async def main() -> int:
    async with Client() as client:
        t = client.transport
        try:
            result = await assess_model_fit(
                t,
                models=[
                    {
                        "model_src": model,
                        "model_type": "llamacpp-completion",
                        "model_config": {"ctx_size": CONTEXT_TOKENS},
                    }
                    for model in CANDIDATES
                ],
            )

            print(f"▸ At {CONTEXT_TOKENS} tokens of context, each model alone")
            for candidate, model in zip(CANDIDATES, result.models):
                mark = VERDICT_MARK[model.status.value]
                size = gib(candidate.expected_size).rjust(9)
                print(f"  {mark} {candidate.name.ljust(46)} {size} on disk")
                for device in model.devices:
                    print(
                        f"      {device.name.ljust(10)} {gib(device.used_bytes).rjust(10)}"
                    )

            print(f"\n▸ All five loaded together: {result.verdict.value}")
            for pool in result.pools:
                free = (
                    "no free figure"
                    if pool.free_bytes is None
                    else f"of {gib(pool.free_bytes)} free"
                )
                print(f"  {pool.id.ljust(14)} {gib(pool.used_bytes).rjust(10)} {free}")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
