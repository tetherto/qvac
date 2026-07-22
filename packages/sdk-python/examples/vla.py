"""Python port of packages/sdk/examples/vla-smolvla.ts.

Vision-language-action inference with SmolVLA. Loads the GGUF model, reads the
model's hyperparameters, builds synthetic inputs sized to those hparams
(gray images + BOS-only tokens + zero state + zero noise), runs one inference
pass, and prints the produced action chunk.

The VLA helpers are numpy-based, so this example is guarded on numpy:
  from tetherto.qvac_sdk import vla, vla_hparams, vla_preprocess_image, vla_pad_state

RUN: python examples/vla.py [path-to-smolvla.gguf]
"""

from __future__ import annotations

import asyncio
import sys

from _common import print_progress

from tetherto.qvac_sdk import (
    Client,
    load_model,
    unload_model,
    vla,
    vla_hparams,
    vla_pad_state,
    vla_preprocess_image,
)
from tetherto.qvac_sdk.models import SMOLVLA_LIBERO_VISION_Q8


async def main() -> int:
    try:
        import numpy as np
    except ImportError:
        print("✖ This example needs numpy: pip install numpy", file=sys.stderr)
        return 1

    model_src = sys.argv[1] if len(sys.argv) > 1 else SMOLVLA_LIBERO_VISION_Q8

    async with Client() as client:
        t = client.transport
        try:
            print("▸ Loading SmolVLA model...")
            model_id = await load_model(
                t,
                model_src=model_src,
                model_type="ggml-vla",
                model_config={"backend": "cpu"},
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")

            hparams, backend_name = await vla_hparams(t, model_id=model_id)
            print(f"▸ Backend: {backend_name or '(unknown)'}")
            print(f"▸ Hparams: {hparams}")

            # Synthetic inputs sized to the model's expectations. A real consumer
            # would read camera frames, tokenize the instruction with the
            # SmolVLM2 tokenizer, and read the robot's current end-effector pose.
            size = hparams.vision_image_size
            dummy_pixels = np.full((size, size, 3), 128, dtype=np.uint8)
            front = vla_preprocess_image(dummy_pixels, size, size, size=size)
            wrist = vla_preprocess_image(dummy_pixels, size, size, size=size)

            tokens = np.zeros(hparams.tokenizer_max_length, dtype=np.int32)
            mask = np.zeros(hparams.tokenizer_max_length, dtype=np.uint8)
            # BOS-only "instruction" for the smoke test.
            tokens[0] = 1
            mask[0] = 1

            state = vla_pad_state([0, 0, 0, 0, 0, 0], hparams.max_state_dim)
            noise = np.zeros(
                hparams.chunk_size * hparams.max_action_dim, dtype=np.float32
            )

            print("▸ Running VLA inference...")
            result = await vla(
                t,
                model_id=model_id,
                images=[front, wrist],
                img_width=size,
                img_height=size,
                state=state,
                tokens=tokens,
                mask=mask,
                noise=noise,
            )

            print(f"▸ Got {result.chunk_size} action steps of dim {result.action_dim}.")
            print(list(result.actions[: result.action_dim]))
            if result.stats:
                print(f"▸ Timing: {result.stats}")

            await unload_model(t, model_id)
            print("▸ Model unloaded.")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
