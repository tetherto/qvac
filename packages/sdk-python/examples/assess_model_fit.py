"""Python port of packages/sdk/examples/assess-model-fit.ts.

Which models is this machine likely to run — asked before downloading any
weights. Nothing is fetched, loaded or reserved.

The header prints the evidence the answer rests on: `system-memory` on a
CPU-only or integrated-GPU host, `device-memory` on a discrete card,
`device-budget` for the per-process allowance Windows grants on one. Which
of those applies depends on where the engine would put the model.

`unknown` is a real answer, not an error: the evidence does not support a
call either way. Show it as "can't say", never as "no".

RUN: python examples/assess_model_fit.py
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import AssessModelFitRequest, Client, assess_model_fit
from tetherto.qvac_sdk.models import (
    QWEN3_1_7B_INST_Q4,
    QWEN3_4B_INST_Q4_K_M,
    QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL,
    QWEN3_8B_INST_Q4_K_M,
    QWEN3_600M_INST_Q4,
)

# Sizes the assessment the way it sizes the load: the estimator reads the
# context out of the config `load_model` would be given.
CONTEXT_TOKENS = 8192

# A ladder ending well past what a laptop has, so one screen shows every verdict.
CANDIDATES = [
    QWEN3_600M_INST_Q4,
    QWEN3_1_7B_INST_Q4,
    QWEN3_4B_INST_Q4_K_M,
    QWEN3_8B_INST_Q4_K_M,
    QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL,
]

VERDICT_MARK = {"likely-fits": "✔", "likely-too-large": "✖", "unknown": "?"}


def gib(byte_count: float) -> str:
    return f"{byte_count / 1024**3:.2f} GiB"


async def main() -> int:
    async with Client() as client:
        t = client.transport
        try:
            # The generated stub takes the wire request, so fields are camelCase
            # and the constant is spelled out field by field: JS's assessModelFit
            # wrapper only infers `modelType` and hands the whole descriptor
            # through. The checksum is what matches a candidate to its catalog
            # profile, so a bare `src` string would cost the profile and leave
            # `name` as the full registry:// URL. `modelConfig` collides with
            # pydantic's own attribute, so build the request from a dict.
            request = AssessModelFitRequest.model_validate(
                {
                    "type": "assessModelFit",
                    "models": [
                        {
                            "modelSrc": {
                                "src": model.src,
                                "name": model.name,
                                "sha256Checksum": model.sha256_checksum,
                                "registryPath": model.registry_path,
                                "registrySource": model.registry_source,
                            },
                            "modelType": "llamacpp-completion",
                            "modelConfig": {"ctx_size": CONTEXT_TOKENS},
                        }
                        for model in CANDIDATES
                    ],
                    # Declared for aggregation only, not a scheduling instruction:
                    # "sequential" counts the largest operation peak, "concurrent"
                    # counts one per model.
                    "execution": "sequential",
                    "policy": "interactive-v1",
                }
            )
            result = await assess_model_fit(t, request)

            print(f"▸ Budget basis: {result.basis.value}")
            if result.budget:
                print(
                    f"    {gib(result.budget.available_after_reserve_bytes)} budget"
                    f" ({gib(result.budget.total_bytes)} total,"
                    f" {gib(result.budget.used_bytes)} in use,"
                    f" {gib(result.budget.available_bytes)} free,"
                    f" {gib(result.budget.reserved_bytes)} held back)"
                )

            # Says which device the verdicts assume, when the model would run on a GPU.
            placement = next(
                (
                    line
                    for line in result.assumptions
                    if "assumed to execute on" in line
                ),
                None,
            )
            if placement:
                print(f"▸ {placement}")

            print(f"\n▸ At {CONTEXT_TOKENS} tokens of context")
            for index, model in enumerate(result.models):
                # The generated verdict/evidence fields are enums, not strings:
                # `model.verdict == "unknown"` is always False, so read `.value`.
                mark = VERDICT_MARK[model.verdict.value]
                size = gib(CANDIDATES[index].expected_size).rjust(9)
                computed_only = (
                    model.evidence is not None
                    and model.evidence.value == "computed-only"
                )
                needs = (
                    f"at least {gib(model.floor_bytes)}"
                    if computed_only and model.floor_bytes
                    else ""
                )
                print(f"  {mark} {model.name.ljust(46)} {size} on disk  {needs}")
                # Present on every `unknown`, and worth surfacing: it names what is missing.
                if model.verdict.value == "unknown":
                    for reason in model.reasons:
                        print(f"      {reason}")

            print(f"\n▸ All five together, sequentially: {result.verdict.value}")
            print(
                "▸ Advisory only — this does not gate load_model or reserve anything."
            )
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
