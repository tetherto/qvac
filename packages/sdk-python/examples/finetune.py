"""Python port of packages/sdk/examples/finetune/llamacpp-finetune.ts.

LoRA fine-tuning on a chat dataset with a separate eval file, printing every
progress tick. Pass `--pause-resume` to pause the run mid-training and resume
it from the last checkpoint.

`finetune_with_progress` is a server-stream: it yields `FinetuneProgressResponse`
ticks and ends with the terminal `FinetuneResponse`. A pause is a separate unary
`finetune` call carrying `operation="pause"`, sent while that stream is open.

`train.jsonl` and `eval.jsonl` must sit next to this file. The adapter and its
checkpoints are written under `./finetune-output`, relative to the directory you
run from.

RUN: python examples/finetune.py [--pause-resume]
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from tetherto.qvac_sdk import (
    Client,
    FinetuneRequest,
    finetune,
    finetune_with_progress,
    load_model,
    unload_model,
)
from tetherto.qvac_sdk.models import QWEN3_600M_INST_Q4

# The worker resolves dataset paths against the process working directory, so
# derive them from this file's own folder instead.
DATASET_DIR = Path(__file__).parent
RESULTS_DIR = "./finetune-output"


def tick_line(tick) -> str:
    """One progress tick, train or validation."""
    phase = "train" if tick.is_train else "val"
    # loss and accuracy are absent on some ticks, so guard the formatting.
    loss = f"{tick.loss:.4f}" if tick.loss is not None else "-"
    accuracy = f"{tick.accuracy:.4f}" if tick.accuracy is not None else "-"
    return (
        f"▸ epoch={tick.current_epoch + 1} step={tick.global_steps}"
        f" batch={tick.current_batch}/{tick.total_batches} {phase}"
        f" loss={loss} acc={accuracy} eta={round(tick.eta_ms / 1000)}s"
    )


async def read_progress(t, request, on_tick=None):
    """Print each tick as it arrives; return the terminal result."""
    result = None
    async for frame in finetune_with_progress(t, request):
        if frame.type == "finetune":
            result = frame
            continue
        print(tick_line(frame))
        if on_tick is not None:
            on_tick(frame.global_steps)
    return result


async def main() -> int:
    pause_resume_enabled = "--pause-resume" in sys.argv

    async with Client() as client:
        t = client.transport
        model_id = None
        try:
            model_id = await load_model(
                t,
                model_src=QWEN3_600M_INST_Q4,
                model_config={"device": "gpu", "ctx_size": 512},
            )
            print(f"▸ Model loaded with ID: {model_id}")

            finetune_params = {
                "type": "finetune",
                "modelId": model_id,
                "options": {
                    "trainDatasetDir": str(DATASET_DIR / "train.jsonl"),
                    "validation": {
                        "type": "dataset",
                        "path": str(DATASET_DIR / "eval.jsonl"),
                    },
                    "numberOfEpochs": 2,
                    "learningRate": 1e-4,
                    "lrMin": 1e-8,
                    "loraModules": "attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down",
                    "assistantLossOnly": True,
                    "checkpointSaveSteps": 2,
                    "checkpointSaveDir": f"{RESULTS_DIR}/checkpoints",
                    "outputParametersDir": RESULTS_DIR,
                },
            }

            pause_task = None

            def request_pause(global_steps) -> None:
                nonlocal pause_task
                if not pause_resume_enabled or pause_task is not None:
                    return
                if global_steps >= 10:
                    print("▸ Requesting a pause so the run can be resumed...")
                    # Fired as a task: the progress stream above is still being
                    # drained, and the pause reply arrives on its own call.
                    pause_task = asyncio.create_task(
                        finetune(
                            t,
                            FinetuneRequest.model_validate(
                                {
                                    "type": "finetune",
                                    "modelId": model_id,
                                    "operation": "pause",
                                }
                            ),
                        )
                    )

            initial_result = await read_progress(
                t,
                FinetuneRequest.model_validate(finetune_params),
                request_pause,
            )

            if pause_task is not None:
                await pause_task

            print(f"▸ Initial finetune result: {initial_result}")

            # `status` is a generated enum, so compare its `.value`.
            if (
                pause_resume_enabled
                and initial_result is not None
                and initial_result.status.value == "PAUSED"
            ):
                print("▸ Resuming from the saved checkpoint...")
                resumed_result = await read_progress(
                    t,
                    FinetuneRequest.model_validate(
                        {**finetune_params, "operation": "resume"}
                    ),
                )
                print(f"▸ Resumed finetune result: {resumed_result}")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
        finally:
            if model_id is not None:
                await unload_model(t, model_id)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
