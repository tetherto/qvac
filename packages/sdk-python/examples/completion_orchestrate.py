"""Worker-orchestrated tool loop — mirrors the SDK's server-side tool loop
(beyond the client-side loop in completion_tools.py).

`completion_orchestrate()` hands the multi-turn tool loop to the WORKER: when
the model asks for a tool, the worker emits a callback frame, this client runs
the registered `handler`, writes the result back, and generation continues —
no manual history stitching. Every tool needs a `handler` (it runs code on
this machine, so only a local worker may orchestrate).

Advanced path: `completion_orchestrate` lives in `tetherto.qvac_sdk._completion` rather than
the flat `tetherto.qvac_sdk` surface. The public tool API is `completion(tools=...)` (the
client-side loop in completion_tools.py), matching the JS SDK; worker
orchestration has no JS client wrapper yet.

RUN: python examples/completion_orchestrate.py
"""

from __future__ import annotations

import asyncio
import sys

from _common import print_progress

from tetherto.qvac_sdk import Client, load_model, unload_model
from tetherto.qvac_sdk._completion import completion_orchestrate
from tetherto.qvac_sdk.models import QWEN3_1_7B_INST_Q4


async def get_weather(arguments) -> str:
    return f"The weather in {arguments.get('location')} is 22°C and sunny."


async def get_horoscope(arguments) -> str:
    return f"{arguments.get('sign')}: today favours careful validation."


TOOLS = [
    {
        "name": "get_weather",
        "description": "Get the current weather for a location",
        "parameters": {
            "type": "object",
            "properties": {"location": {"type": "string"}},
            "required": ["location"],
        },
        "handler": get_weather,
    },
    {
        "name": "get_horoscope",
        "description": "Get the horoscope for a star sign",
        "parameters": {
            "type": "object",
            "properties": {"sign": {"type": "string"}},
            "required": ["sign"],
        },
        "handler": get_horoscope,
    },
]


async def main() -> int:
    async with Client() as client:
        t = client.transport
        try:
            model_id = await load_model(
                t,
                model_src=QWEN3_1_7B_INST_Q4,
                model_config={"ctx_size": 4096, "tools": True},
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}\n")

            run = completion_orchestrate(
                t,
                model_id=model_id,
                history=[
                    {
                        "role": "user",
                        "content": "What's the weather in Tokyo and my horoscope for Aquarius?",
                    }
                ],
                tools=TOOLS,
                max_tool_turns=4,
            )

            async for event in run.events:
                if event.type == "contentDelta":
                    sys.stdout.write(event.text)
                    sys.stdout.flush()

            final = await run.final
            print("\n\n▸ Final answer:", final.content_text)

            await unload_model(t, model_id)
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
