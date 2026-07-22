"""Python port of packages/sdk/examples/quickstart.ts.

Load a model (with download progress), run a streaming completion, unload.

The one structural difference from the JS SDK: this client is asyncio-native,
so top-level calls live inside `async def main()`. A `Client()` from a bundled
wheel needs no configuration; against a thin install, point QVAC_SDK_DIR at a
built `@qvac/sdk`.

RUN: python examples/quickstart.py
"""

from __future__ import annotations

import asyncio
import sys

from _common import print_progress

from tetherto.qvac_sdk import Client, completion, load_model, unload_model
from tetherto.qvac_sdk.models import LLAMA_3_2_1B_INST_Q4_0


async def main() -> int:
    async with Client() as client:
        t = client.transport
        try:
            model_id = await load_model(
                t, model_src=LLAMA_3_2_1B_INST_Q4_0, on_progress=print_progress
            )

            run = completion(
                t,
                model_id=model_id,
                history=[
                    {
                        "role": "user",
                        "content": "Explain quantum computing in one sentence",
                    }
                ],
            )
            async for event in run.events:
                if event.type == "contentDelta":
                    sys.stdout.write(event.text)
                    sys.stdout.flush()
            print()

            await unload_model(t, model_id)
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
