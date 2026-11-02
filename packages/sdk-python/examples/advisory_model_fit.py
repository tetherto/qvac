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

from tetherto.qvac_sdk import SDK_LOG_ID, Client, load_model, logging_stream
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
            # gpt-oss-20B fits here at the default KV cache type and does not at f32.
            await load_model(
                t,
                model_src=GPT_OSS_20B_INST_Q4_K_M,
                model_config={
                    "ctx_size": 131072,
                    "cache-type-k": "f32",
                    "cache-type-v": "f32",
                },
                model_fit_policy="refuse",
            )

            print("▸ Loaded — the fitter projected this one to fit here")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
        finally:
            verdicts.cancel()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
