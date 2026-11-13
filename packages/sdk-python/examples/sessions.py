"""Python port of packages/sdk/examples/sessions.ts.

Two caller sessions on one runtime. Each session gets its own requests and
model leases:

  - Both sessions load the same configuration and get the same `model_id`;
    the second load adds a lease instead of loading the model again.
  - A session's `cancel(request_id=...)` reaches only its own requests, so
    the second session's cancel leaves the first session's completion
    running; the first session's own cancel stops it.
  - `unload_model()` releases the caller's lease. The model unloads when its
    last lease is released, here when the second session closes.

Pass `session.transport` wherever a function takes a transport. Only
`Client`'s exit stops the runtime; it ends every session.

RUN: python examples/sessions.py
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import Client, cancel, completion, load_model, unload_model
from tetherto.qvac_sdk.methods import get_loaded_model_info
from tetherto.qvac_sdk.models import QWEN3_600M_INST_Q4
from tetherto.qvac_sdk.schemas import GetLoadedModelInfoRequest


async def lease_count(transport, model_id: str) -> int | None:
    response = await get_loaded_model_info(
        transport,
        GetLoadedModelInfoRequest.model_validate(
            {"type": "getLoadedModelInfo", "modelId": model_id}
        ),
    )
    return response.info.lease_count


async def main() -> int:
    async with Client() as client:
        try:
            harness = await client.open_session(name="harness")
            skill_runner = await client.open_session(name="skill-runner")

            model_id = await load_model(
                harness.transport,
                model_src=QWEN3_600M_INST_Q4,
                model_config={"ctx_size": 4096},
            )
            same_model_id = await load_model(
                skill_runner.transport,
                model_src=QWEN3_600M_INST_Q4,
                model_config={"ctx_size": 4096},
            )
            print(
                f"▸ same model for both sessions: {model_id == same_model_id}, "
                f"leases: {await lease_count(client.transport, model_id)}"
            )

            run = completion(
                harness.transport,
                model_id=model_id,
                history=[
                    {
                        "role": "user",
                        "content": "Write a long essay about the history of Rome.",
                    }
                ],
            )

            # The skill runner cannot reach the harness's request.
            await cancel(skill_runner.transport, request_id=run.request_id)

            deltas_after_foreign_cancel = 0
            stop_reason = None
            async for event in run.events:
                if event.type == "contentDelta":
                    deltas_after_foreign_cancel += 1
                    # The harness stops its own completion after a few more tokens.
                    if deltas_after_foreign_cancel == 5:
                        await cancel(harness.transport, request_id=run.request_id)
                elif event.type == "completionDone":
                    reason = getattr(event, "stop_reason", None)
                    stop_reason = getattr(reason, "value", reason)
            print(
                f"▸ {deltas_after_foreign_cancel} tokens arrived after skill-runner's "
                f"cancel; harness's cancel ended the run: stopReason={stop_reason}"
            )

            await unload_model(harness.transport, model_id)
            print(
                "▸ harness released its lease; "
                f"leases left: {await lease_count(client.transport, model_id)}"
            )

            # Closing a session releases its leases; this was the model's last one.
            await skill_runner.close()
            print("▸ skill-runner closed and released the last lease")

            await harness.close()
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
