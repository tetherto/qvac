"""Python port of packages/sdk/examples/cancel-by-request-id.ts.

Cancel a specific in-flight completion by `request_id`. `completion()` exposes
a stable `request_id` (UUIDv4, client-generated) on the returned run; pass it
to `cancel(request_id=...)` to abort that exact run.

Cancel surfaces on two channels, matching JS:
  - `run.events` ends *normally* with a `completionDone` carrying
    `stop_reason == "cancelled"` — no exception.
  - awaiting `run.final` raises `InferenceCancelledError`, whose `partial_*`
    fields hold whatever the model produced before the cancel landed.

RUN: python examples/cancel.py
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import (
    Client,
    InferenceCancelledError,
    cancel,
    completion,
    load_model,
    unload_model,
)
from tetherto.qvac_sdk.models import QWEN3_600M_INST_Q4


async def main() -> int:
    async with Client() as client:
        t = client.transport
        try:
            model_id = await load_model(
                t, model_src=QWEN3_600M_INST_Q4, model_config={"ctx_size": 4096}
            )

            run = completion(
                t,
                model_id=model_id,
                history=[
                    {
                        "role": "user",
                        "content": "Write a long, detailed essay about the history of the Roman Empire.",
                    }
                ],
            )
            print(f"▸ requestId: {run.request_id}")

            async def cancel_soon() -> None:
                await asyncio.sleep(0.25)
                await cancel(t, request_id=run.request_id)
                print("▸ cancel issued")

            canceller = asyncio.create_task(cancel_soon())

            # Channel 1: the events stream ends normally on cancel.
            token_count = 0
            end_reason = None
            async for event in run.events:
                if event.type == "contentDelta":
                    token_count += 1
                    sys.stdout.write(event.text)
                    sys.stdout.flush()
                elif event.type == "completionDone":
                    end_reason = getattr(event, "stop_reason", None)
            print(
                f"\n\n▸ streamed {token_count} content deltas, stopReason={end_reason}"
            )

            # Channel 2: awaiting final raises InferenceCancelledError.
            try:
                text = await run.text()
                print(f"▸ completed normally ({len(text)} chars)")
            except InferenceCancelledError as err:
                print(f"▸ run.final rejected: cancelled (requestId={err.request_id})")
                print(f"▸ partial text length: {len(err.partial_text or '')}")
                if (
                    err.partial_stats
                    and err.partial_stats.tokens_per_second is not None
                ):
                    print(
                        f"▸ partial stats: {err.partial_stats.tokens_per_second:.1f} tok/s"
                    )
                if err.partial_tool_calls:
                    print(f"▸ partial tool calls: {len(err.partial_tool_calls)}")

            await canceller
            await unload_model(t, model_id)
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
