"""Python port of packages/sdk/examples/vla-pi05.ts.

π₀.₅ (pi05) vision-language-action inference. Loads the Physical Intelligence
π₀.₅ GGUF model, runs a single inference pass with synthetic inputs
(zero-filled gray images + BOS-only tokens + seeded noise), and prints the
produced action chunk + per-stage timings.

π₀.₅ differs from SmolVLA in two ways the SDK surfaces via `vla_hparams()`:
  - `num_cameras: 3` — it expects exactly three camera frames (not two).
  - `state_input_mode: 'discrete'` — the robot state is tokenised into the
    language prompt, so the `state` buffer is ignored. We pass an empty
    float32 array. π₀.₅ also requires the `noise` prior.

By default the example pulls the registry-baked π₀.₅ GGUF (~3.9 GB) on first
run and caches it locally. Pass an absolute path on the command line to
override and load a local GGUF instead.

The VLA helpers are numpy-based, so this example is guarded on numpy.

RUN: python examples/vla_pi05.py [path-to-pi05.gguf]
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import (
    Client,
    load_model,
    unload_model,
    vla,
    vla_hparams,
    vla_preprocess_image,
)
from tetherto.qvac_sdk.models import PI05_BASE_Q_AGGRESSIVE


def print_progress(p) -> None:
    """Print model download progress; pass as `on_progress=` to `load_model`."""
    line = (
        f"▸ Downloading {p.percentage:.0f}% "
        f"({p.downloaded / 1e6:.1f}/{p.total / 1e6:.1f} MB)"
    )
    print(line, end="\r" if sys.stderr.isatty() else "\n", file=sys.stderr)
    if p.percentage >= 100:
        print(file=sys.stderr)


async def main() -> int:
    try:
        import numpy as np
    except ImportError:
        print("✖ This example needs numpy: pip install numpy", file=sys.stderr)
        return 1

    model_src = sys.argv[1] if len(sys.argv) > 1 else PI05_BASE_Q_AGGRESSIVE

    async with Client() as client:
        t = client.transport
        try:
            print("▸ Loading π₀.₅ (pi05) model...")
            model_id = await load_model(
                t,
                model_src=model_src,
                model_type="ggml-vla",
                model_config={"backend": ["cpu"]},
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")

            hparams, backend_name = await vla_hparams(t, model_id=model_id)
            print(f"▸ Backend: {backend_name or '(unknown)'}")
            print(f"▸ Hparams: {hparams}")

            # Build synthetic inputs sized to the model's expectations. A real
            # consumer would: read camera frames, tokenize the instruction with
            # the model's tokenizer, and (for π₀.₅) inline the robot state into
            # the prompt.
            size = hparams.vision_image_size
            num_cameras = hparams.num_cameras or 3
            dummy_pixels = np.full((size, size, 3), 128, dtype=np.uint8)
            # π₀.₅ expects exactly `num_cameras` frames.
            images = [
                vla_preprocess_image(dummy_pixels, size, size, size=size)
                for _ in range(num_cameras)
            ]

            tokens = np.zeros(hparams.tokenizer_max_length, dtype=np.int32)
            mask = np.zeros(hparams.tokenizer_max_length, dtype=np.uint8)
            # BOS-only "instruction" for the smoke test.
            tokens[0] = 1
            mask[0] = 1

            # Discrete-state model: the state buffer is ignored (state is
            # tokenised into the prompt), so pass an empty array. π₀.₅
            # requires `noise`.
            state = np.zeros(0, dtype=np.float32)
            noise = np.zeros(
                hparams.chunk_size * hparams.max_action_dim, dtype=np.float32
            )

            print("▸ Running VLA inference...")
            result = await vla(
                t,
                model_id=model_id,
                images=images,
                img_width=size,
                img_height=size,
                state=state,
                tokens=tokens,
                mask=mask,
                noise=noise,
            )

            print(f"▸ Got {result.chunk_size} action steps of dim {result.action_dim}.")
            print(result.actions[: result.action_dim].tolist())
            if result.stats:
                s = result.stats
                print(
                    f"▸ Timing: vision={s.get('vision_ms', 0):.0f}ms "
                    f"prefill={s.get('prefill_total_ms', 0):.0f}ms "
                    f"ode={s.get('ode_ms', 0):.0f}ms "
                    f"total={s.get('total_ms', 0):.0f}ms"
                )

            await unload_model(t, model_id)
            print("▸ Model unloaded.")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
