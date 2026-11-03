"""Python port of packages/sdk/examples/diffusion-ic-lora-ltx.ts.

Reference-conditioned text-to-video with LTX-2 and an Ingredients (IC) LoRA.
The LoRA is applied at runtime (`lora_apply_mode: 'at_runtime'`), and a
composite reference sheet is handed to generation in `reference_images` so the
clip inherits the character / style it shows. Reference conditioning needs at
least 121 frames, hence `video_frames: 217`.

This example needs powerful hardware: LTX-2.3 is a ~21B model, budget at least
20+ GB of video / unified memory.

TypeScript's `video()` takes `reference_images` as raw bytes and base64-encodes
them on the way to the worker. Python calls the worker directly through
`video_stream`, where each entry is already the encoded string, so the example
encodes the file itself. The same iterator then carries progress, the finished
clips and the closing stats, which TypeScript receives as three separate
channels.

RUN: python examples/diffusion_ic_lora_ltx.py <absolute-lora-path> <reference-sheet-path> [prompt] [output-dir]
"""

from __future__ import annotations

import asyncio
import base64
import sys
from pathlib import Path

from tetherto.qvac_sdk import (
    Client,
    VideoStreamRequest,
    load_model,
    unload_model,
    video_stream,
)
from tetherto.qvac_sdk.models import (
    GEMMA_3_12B_Q4_K_XL,
    LTX_2_3_22B_DISTILLED_EMBEDDINGS_CONNECTORS,
    LTX_2_3_22B_Q5_K_M,
    LTX_2_3_AUDIO_VAE,
    LTX_2_3_VIDEO_VAE,
)


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
    lora_path = sys.argv[1] if len(sys.argv) > 1 else None
    reference_path = sys.argv[2] if len(sys.argv) > 2 else None
    prompt = (
        sys.argv[3]
        if len(sys.argv) > 3
        else (
            "Reference sheet: a red-haired explorer in a blue parka. Generated "
            "video: the explorer crosses a snowy ridge at sunrise."
        )
    )
    output_dir = Path(sys.argv[4]) if len(sys.argv) > 4 else Path(".")

    if not lora_path or not reference_path:
        print(
            "Usage: python examples/diffusion_ic_lora_ltx.py "
            "<absolute-lora-path> <reference-sheet-path> [prompt] [output-dir]",
            file=sys.stderr,
        )
        return 1
    if not Path(lora_path).is_absolute():
        print(
            "✖ The LoRA adapter path must be absolute on the inference worker.",
            file=sys.stderr,
        )
        return 1

    reference_sheet = base64.b64encode(Path(reference_path).read_bytes()).decode(
        "ascii"
    )

    try:
        async with Client() as client:
            t = client.transport

            model_id = await load_model(
                t,
                model_src=LTX_2_3_22B_Q5_K_M,
                model_type="sdcpp-generation",
                model_config={
                    "mode": "video",
                    "device": "gpu",
                    "threads": 4,
                    "llmModelSrc": GEMMA_3_12B_Q4_K_XL,
                    "vaeModelSrc": LTX_2_3_VIDEO_VAE,
                    "audioVaeModelSrc": LTX_2_3_AUDIO_VAE,
                    "embeddingsConnectorsModelSrc": (
                        LTX_2_3_22B_DISTILLED_EMBEDDINGS_CONNECTORS
                    ),
                    "diffusion_fa": True,
                    "offload_to_cpu": True,
                    "vae_tiling": True,
                    # Keep the LoRA out of the loaded weights so it can be
                    # swapped per request.
                    "lora_apply_mode": "at_runtime",
                },
                on_progress=print_progress,
            )

            request = VideoStreamRequest.model_validate(
                {
                    "type": "videoStream",
                    "modelId": model_id,
                    "mode": "txt2vid",
                    "prompt": prompt,
                    "negative_prompt": (
                        "blurry, low quality, static, jittery, watermark"
                    ),
                    "width": 768,
                    "height": 448,
                    # Reference conditioning requires at least 121 frames.
                    "video_frames": 217,
                    "fps": 24,
                    "steps": 8,
                    "scheduler": "ltx2",
                    "cfg_scale": 1,
                    "seed": 84,
                    "lora": lora_path,
                    "lora_strength": 1.37,
                    "stg_scale": 1,
                    "stg_block": 29,
                    "reference_images": [reference_sheet],
                    "reference_attention_strength": 1,
                    "reference_downscale_factor": 1,
                    "temporal_tiling": True,
                    "vae_tile_size": 4,
                }
            )

            clips: list[bytes] = []
            stats = None
            async for response in video_stream(t, request):
                if response.step is not None and response.total_steps is not None:
                    print(f"▸ step {response.step:.0f}/{response.total_steps:.0f}")
                if response.data is not None:
                    clips.append(base64.b64decode(response.data))
                if response.done:
                    stats = response.stats

            output_dir.mkdir(parents=True, exist_ok=True)
            for index, clip in enumerate(clips):
                output_path = output_dir / f"ltx_ic_lora_{index}.avi"
                output_path.write_bytes(clip)
                print(f"▸ Saved {output_path}")

            print("▸ Stats:", stats.model_dump(exclude_none=True) if stats else None)

            await unload_model(t, model_id, clear_storage=False)
    except Exception as error:
        print("✖", error, file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
