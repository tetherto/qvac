"""Python port of packages/sdk/examples/logging-global.ts.

Capture every server-side log (SDK server, all models, RAG) with a single
`subscribe_server_logs` subscription.

`config/logging/logging.config.json` (next to this script) sets
`loggerConsoleOutput: false`, which disables the worker's default console
output, so the only logs printed are the ones the handler below receives. The
TypeScript example points `QVAC_CONFIG_PATH` at that file; the Python client
takes the config as `Client(config=...)`, so the example reads the same file
and passes it in.

RUN: python examples/logging_global.py
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from tetherto.qvac_sdk import (
    Client,
    completion,
    load_model,
    subscribe_server_logs,
    unload_model,
)
from tetherto.qvac_sdk.models import LLAMA_3_2_1B_INST_Q4_0

CONFIG_PATH = Path(__file__).parent / "config" / "logging" / "logging.config.json"


def print_log(log) -> None:
    print(f"[SDK] [{log.level.value.upper()}] [{log.namespace}] {log.message}")


async def main() -> int:
    config = json.loads(CONFIG_PATH.read_text())

    async with Client(config=config) as client:
        t = client.transport
        try:
            print("▸ Starting global logging demo...\n")

            # One subscription captures every server-side log (SDK, models,
            # RAG, …) without having to know any stream IDs ahead of time.
            unsubscribe = subscribe_server_logs(t, print_log)

            model_id = await load_model(
                t,
                model_src=LLAMA_3_2_1B_INST_Q4_0,
                model_config={"ctx_size": 2048},
            )

            run = completion(
                t,
                model_id=model_id,
                history=[{"role": "user", "content": "Count from 1 to 5."}],
            )

            print("▸ Response:\n")
            async for event in run.events:
                if event.type == "contentDelta":
                    sys.stdout.write(event.text)
                    sys.stdout.flush()

            await unload_model(t, model_id)
            unsubscribe()
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
