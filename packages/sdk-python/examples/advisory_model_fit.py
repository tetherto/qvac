"""Python port of packages/sdk/examples/advisory-model-fit.ts.

`modelFitPolicy` decides what the engine fitter's verdict does to a load:
`log` (the default) reports it and loads anyway, `refuse` rejects a load the
fitter projects will not fit, `off` skips the check.

RUN: python examples/advisory_model_fit.py
"""

from __future__ import annotations

import asyncio
import contextlib
import sys

from tetherto.qvac_sdk import SDK_LOG_ID, Client, LoadModelRequest, logging_stream
from tetherto.qvac_sdk.methods import load_model
from tetherto.qvac_sdk.models import GPT_OSS_20B_INST_Q4_K_M


async def print_fit_verdicts(t) -> None:
    """Verdicts go to the SDK server log stream, not stdout."""
    with contextlib.suppress(asyncio.CancelledError, Exception):
        async for log in logging_stream(t, SDK_LOG_ID):
            if "[advisory-fit:" in log.message:
                print(f"▸ {log.message}")


async def main() -> int:
    async with Client() as client:
        t = client.transport
        verdicts = asyncio.create_task(print_fit_verdicts(t))
        try:
            # The ergonomic `load_model` wrapper has no `model_fit_policy`
            # parameter, so the policy goes through the generated stub instead:
            # camelCase fields, `modelSrc` as the constant's `src` string, and
            # the `modelType` the wrapper would otherwise infer.
            #
            # gpt-oss-20B fits here at the default KV cache type and does not at f32.
            request = LoadModelRequest.model_validate(
                {
                    "type": "loadModel",
                    "modelSrc": GPT_OSS_20B_INST_Q4_K_M.src,
                    "modelType": "llamacpp-completion",
                    "modelConfig": {
                        "ctx_size": 131072,
                        "cache-type-k": "f32",
                        "cache-type-v": "f32",
                    },
                    "modelFitPolicy": "refuse",
                }
            )
            resp = await load_model(t, request)
            if not resp.success:
                print(f"✖ {resp.error}", file=sys.stderr)
                return 1

            print("▸ Loaded — the fitter projected this one to fit here")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
        finally:
            verdicts.cancel()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
