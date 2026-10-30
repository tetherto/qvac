"""Python port of packages/sdk/examples/vla-groot.ts.

NVIDIA GR00T N1.7-3B (vision-language-action) inference. Loads the
GR00T-N1.7-3B LIBERO GGUF model, runs a single inference pass with synthetic
inputs, and prints the produced action chunk + per-stage timings.

GR00T differs from SmolVLA / π₀.₅ in the ways the SDK surfaces via
`vla_hparams()`:
  - `image_input_mode: 'patches'` — each `images` entry is a pre-patchified
    buffer of `hparams.image_patch_elems` floats, NOT a `3·w·h` pixel plane.
    A real consumer patchifies each camera frame the way `Gr00tPolicy` does
    (the model's learned patch-embed runs inside the addon); here we feed
    synthetic patch buffers of the right length.
  - `state_input_mode: 'continuous'` — the robot state is projected by an
    in-model linear layer; pad it to `hparams.max_state_dim` with
    `vla_pad_state`.
  - `noise` is REQUIRED. GR00T is a flow-matching model that does not sample
    its own prior; a missing `noise` is rejected as INVALID_INPUT.

The prompt must place one contiguous run of `MERGED_TOKENS_PER_IMAGE`
image-placeholder tokens per camera. A real consumer produces this by
tokenising the instruction with the Qwen3-VL tokenizer, which inserts the
image tokens; we lay it out by hand for the smoke.

By default the example pulls the registry-baked GR00T-LIBERO GGUF (~3.76 GB)
on first run and caches it locally. Pass an absolute path on the command line
to override and load a local GGUF instead.

Multi-embodiment GGUFs (vla-ggml >= 0.17.0): one GGUF can carry many
embodiments, one active at a time. Optional env vars demonstrate selection:
  QVAC_GROOT_EMBODIMENT        initial selection at load — a tag
                               (e.g. 'libero_sim') or a numeric cat_id
  QVAC_GROOT_SWITCH_EMBODIMENT after load, switch via vla_set_embodiment()
                               and run inference on the new embodiment
Both are no-ops you can omit; the GGUF's default embodiment is used. On a
single-embodiment GGUF a switch is rejected by the addon.

The VLA helpers are numpy-based, so this example is guarded on numpy.

RUN: python examples/vla_groot.py [path-to-groot.gguf]
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

from tetherto.qvac_sdk import (
    Client,
    load_model,
    unload_model,
    vla,
    vla_hparams,
    vla_pad_state,
    vla_set_embodiment,
)
from tetherto.qvac_sdk.models import GROOT_Q8_VF16

# LIBERO GR00T prompt layout (Qwen3-VL tokenizer). GR00T reports
# `hparams.tokenizer_max_length == 0` — it does not surface a tokenizer
# length, so the prompt length is fixed by the model: 2 cameras × 64 merged
# image tokens (256 patches, 2×2 merge) = 128 image tokens, plus text ≈ 150
# total. A real consumer gets these from the tokenizer; the smoke hard-codes
# them. The prompt length follows the ACTIVE embodiment's camera count (a
# 4-camera DROID row needs 4 image-token runs, which a fixed 2-camera length
# cannot hold), so it is computed per inference, not a constant.
IMAGE_TOKEN_ID = 151655
MERGED_TOKENS_PER_IMAGE = 64
PROMPT_TEXT_TAIL = 20
TEXT_TOKEN_ID = 1000


def print_progress(p) -> None:
    """Print model download progress; pass as `on_progress=` to `load_model`."""
    line = (
        f"▸ Downloading {p.percentage:.0f}% "
        f"({p.downloaded / 1e6:.1f}/{p.total / 1e6:.1f} MB)"
    )
    print(line, end="\r" if sys.stderr.isatty() else "\n", file=sys.stderr)
    if p.percentage >= 100:
        print(file=sys.stderr)


def embodiment_from_env(name: str) -> str | int | None:
    """A tag string or a numeric cat_id, straight from the env. '24' is a
    cat_id, 'libero_sim' a tag."""
    raw = os.environ.get(name)
    if not raw:
        return None
    return int(raw) if raw.isdigit() else raw


async def main() -> int:
    try:
        import numpy as np
    except ImportError:
        print("✖ This example needs numpy: pip install numpy", file=sys.stderr)
        return 1

    model_src = sys.argv[1] if len(sys.argv) > 1 else GROOT_Q8_VF16
    embodiment = embodiment_from_env("QVAC_GROOT_EMBODIMENT")
    switch_embodiment = embodiment_from_env("QVAC_GROOT_SWITCH_EMBODIMENT")

    async with Client() as client:
        t = client.transport
        try:
            print("▸ Loading GR00T (N1.7-3B LIBERO) model...")
            model_config: dict = {"backend": ["cpu"]}
            if embodiment is not None:
                model_config["embodiment"] = embodiment
            model_id = await load_model(
                t,
                model_src=model_src,
                model_type="ggml-vla",
                model_config=model_config,
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")

            hparams, backend_name = await vla_hparams(t, model_id=model_id)
            print(f"▸ Backend: {backend_name or '(unknown)'}")
            print(f"▸ Hparams: {hparams}")
            if hparams.selected_embodiment_tag is not None:
                print(
                    f"▸ Embodiment: {hparams.selected_embodiment_tag} "
                    f"(cat_id {hparams.selected_embodiment_cat_id}, "
                    f"{hparams.num_cameras} cameras)"
                )

            # Inputs are sized off the hparams, which follow the ACTIVE
            # embodiment (num_cameras, action_dim, ...) — rebuild them after
            # every embodiment switch.
            async def run_inference(hp) -> None:
                patch_elems = hp.image_patch_elems
                if hp.image_input_mode != "patches" or patch_elems is None:
                    raise RuntimeError(
                        "expected a patch-input model (image_input_mode 'patches' "
                        f"+ image_patch_elems); got image_input_mode={hp.image_input_mode}"
                    )

                num_cameras = hp.num_cameras or 2

                # Patch-input model: each camera is a pre-patchified buffer of
                # exactly `image_patch_elems` floats. A real consumer patchifies
                # each camera frame the way `Gr00tPolicy` does (the model's
                # learned patch-embed runs inside the addon); we use small
                # synthetic values.
                images = [
                    np.full(patch_elems, 0.02, dtype=np.float32)
                    for _ in range(num_cameras)
                ]

                # Continuous-state model: pad the robot state to `max_state_dim`.
                state = vla_pad_state([0, 0, 0, 0, 0, 0], hp.max_state_dim)

                # GR00T requires the noise prior (flow-matching; it is not
                # sampled in-model).
                noise = np.zeros(hp.chunk_size * hp.max_action_dim, dtype=np.float32)

                # Prompt: one run of `MERGED_TOKENS_PER_IMAGE` image tokens per
                # camera, each followed by a text separator, plus a short text
                # tail. Sized off the active embodiment's camera count — a fixed
                # 2-camera length would silently truncate the image-token runs
                # of cameras 3+ after a switch to e.g. the 4-camera DROID row.
                prompt_length = (
                    num_cameras * (MERGED_TOKENS_PER_IMAGE + 1) + PROMPT_TEXT_TAIL
                )
                tokens = np.zeros(prompt_length, dtype=np.int32)
                w = 0
                for cam in range(num_cameras):
                    for _ in range(MERGED_TOKENS_PER_IMAGE):
                        if w >= prompt_length:
                            break
                        tokens[w] = IMAGE_TOKEN_ID
                        w += 1
                    if w < prompt_length:
                        tokens[w] = TEXT_TOKEN_ID + cam
                        w += 1
                for i in range(w, prompt_length):
                    tokens[i] = TEXT_TOKEN_ID + i
                mask = np.ones(prompt_length, dtype=np.uint8)

                print("▸ Running VLA inference...")
                result = await vla(
                    t,
                    model_id=model_id,
                    images=images,
                    # Patch inputs ignore img_width/img_height, but the request
                    # schema requires positive integers; pass the model's
                    # vision image size.
                    img_width=hp.vision_image_size,
                    img_height=hp.vision_image_size,
                    state=state,
                    tokens=tokens,
                    mask=mask,
                    noise=noise,
                )

                print(
                    f"▸ Got {result.chunk_size} action steps of dim {result.action_dim}."
                )
                print(result.actions[: result.action_dim].tolist())
                if result.stats:
                    s = result.stats
                    print(
                        f"▸ Timing: vision={s.get('vision_ms', 0):.0f}ms "
                        f"ode={s.get('ode_ms', 0):.0f}ms "
                        f"total={s.get('total_ms', 0):.0f}ms"
                    )

            await run_inference(hparams)

            if switch_embodiment is not None:
                print(f"▸ Switching embodiment to {json.dumps(switch_embodiment)}...")
                refreshed = await vla_set_embodiment(
                    t, model_id=model_id, embodiment=switch_embodiment
                )
                print(
                    f"▸ Embodiment: {refreshed.selected_embodiment_tag} "
                    f"(cat_id {refreshed.selected_embodiment_cat_id}, "
                    f"{refreshed.num_cameras} cameras)"
                )
                await run_inference(refreshed)

            await unload_model(t, model_id)
            print("▸ Model unloaded.")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
