"""Python port of packages/sdk/examples/completion-events.ts.

The unified typed event stream. `completion()` returns a `CompletionRun` with:

  - `events` — an async iterator of ordered, typed events (`contentDelta`,
    `thinkingDelta`, `toolCall`, `toolError`, `completionStats`,
    `completionDone`, `rawDelta`).
  - `final` — an awaitable `CompletionFinal` with aggregated `content_text`,
    `thinking_text`, `tool_calls`, `stats`, and `raw_full_text`.

Set `capture_thinking=True` for best-effort `<think>` parsing into
`thinkingDelta` events.

RUN: python examples/completion_events.py
"""

from __future__ import annotations

import asyncio
import sys

from _common import print_progress

from tetherto.qvac_sdk import Client, completion, load_model, unload_model
from tetherto.qvac_sdk.models import QWEN3_600M_INST_Q4

DIM = "\x1b[2m"
RESET = "\x1b[0m"


def handle_event(event) -> None:
    if event.type == "contentDelta":
        sys.stdout.write(event.text)
        sys.stdout.flush()
    elif event.type == "thinkingDelta":
        sys.stdout.write(f"{DIM}{event.text}{RESET}")
        sys.stdout.flush()
    elif event.type == "toolCall":
        print(f"\n▸ Tool: {event.call.name}({event.call.arguments})")
    elif event.type == "toolError":
        print(f"\n✖ Tool error [{event.error.code}]: {event.error.message}")
    elif event.type == "completionStats":
        tps = event.stats.tokens_per_second
        print(f"\n▸ {tps:.1f} tok/s" if tps is not None else "")
    elif event.type == "completionDone":
        if getattr(event, "stop_reason", None) == "error" and getattr(
            event, "error", None
        ):
            print(f"\n✖ {event.error.message}")


async def main() -> int:
    async with Client() as client:
        t = client.transport
        try:
            model_id = await load_model(
                t,
                model_src=QWEN3_600M_INST_Q4,
                model_config={"ctx_size": 4096},
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")

            run = completion(
                t,
                model_id=model_id,
                history=[
                    {
                        "role": "user",
                        "content": "Explain quantum computing in 2 sentences",
                    }
                ],
                capture_thinking=True,
            )

            async for event in run.events:
                handle_event(event)

            final = await run.final

            print("\n▸ Final result")
            print(f"▸ Content: {final.content_text}")
            if final.thinking_text:
                print(f"▸ Thinking: {final.thinking_text}")
            if final.stats and final.stats.tokens_per_second is not None:
                print(f"▸ {final.stats.tokens_per_second:.1f} tok/s")
            if final.tool_calls:
                print(f"▸ Tool calls: {', '.join(c.name for c in final.tool_calls)}")
            if final.stop_reason:
                print(f"▸ Stop reason: {final.stop_reason}")
            print(f"▸ Raw output length: {len(final.raw_full_text or '')} chars")

            await unload_model(t, model_id)
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
