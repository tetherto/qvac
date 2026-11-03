"""Python port of packages/sdk/examples/suspend-resume.ts.

Loads a model, runs a completion, suspends the runtime, shows that a new
`completion()` is blocked while suspended, then resumes and runs another
completion. `state()` is sampled at each step.

Python calls the generated `suspend`, `resume` and `state` stubs, so each one
takes its request model. `Client` closes the SDK on exit.

RUN: python examples/suspend_resume.py
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import (
    Client,
    ResumeRequest,
    StateRequest,
    SuspendRequest,
    completion,
    load_model,
    resume,
    state,
    suspend,
    unload_model,
)
from tetherto.qvac_sdk.models import LLAMA_3_2_1B_INST_Q4_0


def print_progress(p) -> None:
    """Print model download progress; pass as `on_progress=` to `load_model`."""
    line = (
        f"▸ Downloading {p.percentage:.0f}% "
        f"({p.downloaded / 1e6:.1f}/{p.total / 1e6:.1f} MB)"
    )
    print(line, end="\r" if sys.stderr.isatty() else "\n", file=sys.stderr)
    if p.percentage >= 100:
        print(file=sys.stderr)


async def lifecycle_state(t) -> str:
    return (await state(t, StateRequest())).state.value


async def stream_completion(t, model_id: str, content: str) -> None:
    run = completion(
        t, model_id=model_id, history=[{"role": "user", "content": content}]
    )
    async for event in run.events:
        if event.type == "contentDelta":
            sys.stdout.write(event.text)
            sys.stdout.flush()
    print()


async def main() -> int:
    async with Client() as client:
        t = client.transport
        try:
            # Load a model
            model_id = await load_model(
                t, model_src=LLAMA_3_2_1B_INST_Q4_0, on_progress=print_progress
            )

            print("▸ Model loaded\n")

            print(f"▸ Lifecycle state: {await lifecycle_state(t)}\n")

            # Run a completion before suspending
            print("▸ Completion before suspend")
            await stream_completion(t, model_id, "Say hello in one word")

            # Suspend all networking and storage (e.g. app going to background)
            print("▸ Suspending...")
            await suspend(t, SuspendRequest())
            print(f"▸ Lifecycle state: {await lifecycle_state(t)}\n")

            try:
                await completion(
                    t,
                    model_id=model_id,
                    history=[{"role": "user", "content": "This should fail"}],
                    stream=False,
                ).text()
            except Exception as error:
                name = getattr(error, "name", None)
                if name == "LIFECYCLE_OPERATION_BLOCKED":
                    print(f"▸ Operation blocked while suspended ({name})")
                else:
                    raise

            # Simulate time in background
            print("\n▸ Simulating 3 seconds in background...")
            await asyncio.sleep(3)

            # Resume when returning to foreground
            print("▸ Resuming...")
            await resume(t, ResumeRequest())
            print(f"▸ Lifecycle state: {await lifecycle_state(t)}\n")

            # Run another completion after resuming
            print("▸ Completion after resume")
            await stream_completion(t, model_id, "Say goodbye in one word")

            await unload_model(t, model_id)
            print("▸ Model unloaded")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
