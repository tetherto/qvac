"""Python port of packages/sdk/examples/tools/llamacpp-native-tools.ts.

The client-side tool loop: run a completion with tool definitions, read back
the model's `tool_calls`, execute them yourself, append the results to the
history, and run a follow-up completion. (For the WORKER to run this loop for
you, see completion_orchestrate.py.)

RUN: python examples/completion_tools.py
"""

from __future__ import annotations

import asyncio
import json
import sys

from _common import print_progress

from tetherto.qvac_sdk import Client, completion, load_model, unload_model
from tetherto.qvac_sdk.models import QWEN3_1_7B_INST_Q4

TOOLS = [
    {
        "name": "get_weather",
        "description": "Get the current weather for a location",
        "parameters": {
            "type": "object",
            "properties": {"location": {"type": "string"}},
            "required": ["location"],
        },
    },
    {
        "name": "get_horoscope",
        "description": "Get the horoscope for a star sign",
        "parameters": {
            "type": "object",
            "properties": {"sign": {"type": "string"}},
            "required": ["sign"],
        },
    },
]


def mock_execute(name, arguments) -> str:
    if name == "get_weather":
        return f"The weather in {arguments.get('location')} is 22°C and sunny."
    if name == "get_horoscope":
        return f"{arguments.get('sign')}: today favours careful validation."
    return "unknown tool"


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
            print(f"▸ Model loaded: {model_id}")

            history = [
                {
                    "role": "system",
                    "content": "You are a helpful assistant that can use tools for weather and horoscopes.",
                },
                {
                    "role": "user",
                    "content": "What's the weather in Tokyo and my horoscope for Aquarius?",
                },
            ]

            print("\n▸ AI Response (streaming with tool definitions):\n")
            run = completion(t, model_id=model_id, history=history, tools=TOOLS)
            async for event in run.events:
                if event.type == "contentDelta":
                    sys.stdout.write(event.text)
                    sys.stdout.flush()
                elif event.type == "toolCall":
                    print(
                        f"\n\n▸ Tool Call: {event.call.name}({json.dumps(dict(event.call.arguments.root))})"
                    )

            final = await run.final
            print("\n\n▸ Parsed Tool Calls:")
            if not final.tool_calls:
                print("▸ No tool calls detected")
            for call in final.tool_calls:
                print(f"▸ {call.name}({json.dumps(call.arguments)})")

            if final.tool_calls:
                print("\n▸ Simulating Tool Execution...")
                history.append({"role": "assistant", "content": final.content_text})
                for call in final.tool_calls:
                    result = mock_execute(call.name, call.arguments)
                    print(f"▸ {call.name}: {result}")
                    history.append({"role": "tool", "content": result})

                print("\n▸ Follow-up Response with Tool Results:\n")
                follow_up = completion(
                    t, model_id=model_id, history=history, tools=TOOLS
                )
                async for event in follow_up.events:
                    if event.type == "contentDelta":
                        sys.stdout.write(event.text)
                        sys.stdout.flush()
                print()

            print("\n▸ Completed!")
            await unload_model(t, model_id)
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
