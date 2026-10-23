"""Deferred tool loading — Python port of
packages/sdk/examples/tools/llamacpp-deferred-tools.ts.

A large tool set stays out of the prompt until the model asks for it. Only
`get_weather` and the built-in `tool_search` (whose description carries a
name-and-description catalog of the rest) are in the initial prompt; the
deferred schemas arrive in the conversation when the model searches for them.

Runs through the worker-orchestrated loop rather than the client-side loop of
completion_tools.py: executing `tool_search` from the client needs the
`executeToolSearch` helper, which only the JS SDK exports. On this path the
worker runs the search itself and calls back only for the real tools.

RUN: python examples/completion_deferred_tools.py
"""

from __future__ import annotations

import asyncio
import json
import sys

from tetherto.qvac_sdk import Client, load_model, unload_model
from tetherto.qvac_sdk._completion import completion_orchestrate
from tetherto.qvac_sdk.models import QWEN3_1_7B_INST_Q4


def print_progress(p) -> None:
    """Print model download progress; pass as `on_progress=` to `load_model`."""
    line = (
        f"▸ Downloading {p.percentage:.0f}% "
        f"({p.downloaded / 1e6:.1f}/{p.total / 1e6:.1f} MB)"
    )
    print(line, end="\r" if sys.stderr.isatty() else "\n", file=sys.stderr)
    if p.percentage >= 100:
        print(file=sys.stderr)


async def get_weather(arguments) -> str:
    return json.dumps(
        {
            "city": arguments.get("city"),
            "country": arguments.get("country", "unknown"),
            "temperature": "22°C",
            "condition": "Partly cloudy",
        }
    )


async def get_horoscope(arguments) -> str:
    return json.dumps(
        {
            "sign": arguments.get("sign"),
            "horoscope": "Today is a great day for new beginnings.",
        }
    )


async def get_moon_phase(arguments) -> str:
    return json.dumps(
        {"date": arguments.get("date", "today"), "phase": "Waxing gibbous"}
    )


# `defer_loading` is the snake_case alias of the wire field `deferLoading`; the
# SDK maps it before sending. `group` is the heading the tool is listed under
# in the catalog, and is ignored for tools that are not deferred.
TOOLS = [
    {
        "name": "get_weather",
        "description": "Get current weather for a city",
        "parameters": {
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "City name"},
                "country": {"type": "string", "description": "Country code"},
            },
            "required": ["city"],
        },
        "handler": get_weather,
    },
    {
        "name": "get_horoscope",
        "description": "Get today's horoscope for an astrological sign",
        "parameters": {
            "type": "object",
            "properties": {
                "sign": {
                    "type": "string",
                    "description": "An astrological sign like Taurus or Aquarius",
                }
            },
            "required": ["sign"],
        },
        "handler": get_horoscope,
        "defer_loading": True,
        "group": "astrology",
    },
    {
        "name": "get_moon_phase",
        "description": "Get the current phase of the moon",
        "parameters": {
            "type": "object",
            "properties": {"date": {"type": "string", "description": "ISO date"}},
        },
        "handler": get_moon_phase,
        "defer_loading": True,
        "group": "astrology",
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
            print(f"▸ Model loaded: {model_id}")
            print("\n▸ Only get_weather and tool_search are in the prompt\n")

            run = completion_orchestrate(
                t,
                model_id=model_id,
                history=[
                    {
                        "role": "system",
                        "content": "You are a helpful assistant. Search for a tool before calling it.",
                    },
                    {"role": "user", "content": "What's my horoscope for Aquarius?"},
                ],
                tools=TOOLS,
                max_tool_turns=4,
            )

            async for event in run.events:
                if event.type == "contentDelta":
                    sys.stdout.write(event.text)
                    sys.stdout.flush()
                elif event.type == "toolCall":
                    arguments = json.dumps(dict(event.call.arguments.root))
                    print(f"\n\n▸ Tool call: {event.call.name}({arguments})\n")

            final = await run.final
            print(f"\n\n▸ Final answer: {final.content_text}")

            print("\n▸ Completed!")
            await unload_model(t, model_id)
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
