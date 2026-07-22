"""Python port of packages/sdk/examples/logging-streaming.ts.

Stream SDK-server and per-model logs concurrently with inference.
`logging_stream(transport, id)` is a server-stream of log records; `id` is a
model id, `SDK_LOG_ID` for the SDK server, or `SDK_ALL_LOG_ID` for everything.

RUN: python examples/logging_streams.py
"""

from __future__ import annotations

import asyncio
import contextlib
import sys

from tetherto.qvac_sdk import (
    SDK_LOG_ID,
    Client,
    completion,
    load_model,
    logging_stream,
    unload_model,
)
from tetherto.qvac_sdk.models import LLAMA_3_2_1B_INST_Q4_0


async def drain_logs(t, log_id, tag) -> None:
    with contextlib.suppress(asyncio.CancelledError, Exception):
        async for log in logging_stream(t, log_id):
            print(
                f"[{tag}] [{log.level.value.upper()}] [{log.namespace}] {log.message}"
            )


async def main() -> int:
    async with Client() as client:
        t = client.transport
        tasks = []
        try:
            print("▸ Streaming SDK and model logs")

            print("▸ Subscribing to SDK server logs")
            tasks.append(asyncio.create_task(drain_logs(t, SDK_LOG_ID, "SDK")))

            print("▸ Loading model")
            model_id = await load_model(
                t,
                model_src=LLAMA_3_2_1B_INST_Q4_0,
                model_config={"ctx_size": 2048, "temp": 0.7},
            )

            print("▸ Subscribing to model logs")
            tasks.append(asyncio.create_task(drain_logs(t, model_id, "LLM")))

            print("▸ Response")
            run = completion(
                t,
                model_id=model_id,
                history=[
                    {
                        "role": "user",
                        "content": "Count from 1 to 5 and explain each number.",
                    }
                ],
                # Bound the generation: at temp 0.7 a 1B model can ignore "to 5"
                # and ramble past ctx_size (2048) into a context overflow. This
                # demo only needs enough tokens to show logs streaming.
                generation_params={"predict": 512},
            )
            async for event in run.events:
                if event.type == "contentDelta":
                    sys.stdout.write(event.text)
                    sys.stdout.flush()
            print()

            print("▸ Two streams ran: [SDK] server, [LLM] inference")
            await unload_model(t, model_id)
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
        finally:
            for task in tasks:
                task.cancel()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
