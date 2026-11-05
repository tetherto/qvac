"""Python port of packages/sdk/examples/diffusion-img2vid.ts.

Image-to-video with Wan 2.1 I2V: a first-frame `init_image` animated by a
motion prompt. The model uses a split layout of four files -- the I2V diffusion
checkpoint plus UMT5-XXL, the Wan VAE and CLIP vision weights -- all handed to
one `load_model` call. The sources default to the registry constants, so the
common case is just an init image path.

TypeScript's `video()` takes `init_image` as raw bytes and base64-encodes them
on the way to the worker. Python calls the worker directly through
`video_stream`, where `init_image` is already the encoded string, so the
example encodes the file itself. The same iterator then carries progress, the
finished clips and the closing stats, which TypeScript receives as three
separate channels.

RUN: python examples/diffusion_img2vid.py <init-image> [prompt] [output-dir] [i2v-src] [t5-src] [vae-src] [clip-vision-src]
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
    CLIP_VISION_H,
    UMT5_XXL_FP16,
    WAN2_1_I2V_14B_Q4_K_M,
    WAN_2_1_COMFYUI_REPACKAGED_VAE,
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
    init_image_path = sys.argv[1] if len(sys.argv) > 1 else None
    prompt = (
        sys.argv[2]
        if len(sys.argv) > 2
        else "the subject slowly turns and smiles, soft natural lighting, cinematic"
    )
    output_dir = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(".")
    diffusion_model_src = sys.argv[4] if len(sys.argv) > 4 else WAN2_1_I2V_14B_Q4_K_M
    t5_xxl_model_src = sys.argv[5] if len(sys.argv) > 5 else UMT5_XXL_FP16
    vae_model_src = sys.argv[6] if len(sys.argv) > 6 else WAN_2_1_COMFYUI_REPACKAGED_VAE
    clip_vision_model_src = sys.argv[7] if len(sys.argv) > 7 else CLIP_VISION_H

    if not init_image_path:
        print("✖ init image path is required", file=sys.stderr)
        print(
            "Usage: python examples/diffusion_img2vid.py <initImagePath> "
            "[prompt] [outputDir] [i2vModelSrc] [t5XxlModelSrc] [vaeModelSrc] "
            "[clipVisionModelSrc]",
            file=sys.stderr,
        )
        return 1

    print("▸ Loading Wan 2.1 I2V model (diffusion + UMT5-XXL + VAE + CLIP vision)...")

    try:
        async with Client() as client:
            t = client.transport

            model_id = await load_model(
                t,
                model_src=diffusion_model_src,
                model_type="sdcpp-generation",
                model_config={
                    "mode": "video",
                    "device": "gpu",
                    "threads": 4,
                    "t5XxlModelSrc": t5_xxl_model_src,
                    "vaeModelSrc": vae_model_src,
                    "clipVisionModelSrc": clip_vision_model_src,
                    "diffusion_fa": True,
                    "offload_to_cpu": True,
                    "params_backend": "vae=cpu",
                    "vae_tiling": True,
                },
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")

            init_image = base64.b64encode(Path(init_image_path).read_bytes()).decode(
                "ascii"
            )
            print(f'▸ Generating video for: "{prompt}"')

            request = VideoStreamRequest.model_validate(
                {
                    "type": "videoStream",
                    "modelId": model_id,
                    "mode": "img2vid",
                    "prompt": prompt,
                    "init_image": init_image,
                    "negative_prompt": (
                        "blurry, distorted, low quality, jittery, static, frozen"
                    ),
                    "strength": 0.85,
                    "flow_shift": 3.0,
                    "video_frames": 33,
                    "fps": 16,
                    "steps": 30,
                    "cfg_scale": 6.0,
                    "seed": 42,
                    "vae_tiling": True,
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

            for index, clip in enumerate(clips):
                output_path = output_dir / f"wan_i2v_{index}.avi"
                output_path.write_bytes(clip)
                print(f"▸ Saved {output_path}")

            print("▸ Stats:", stats.model_dump(exclude_none=True) if stats else None)

            await unload_model(t, model_id)
            print("▸ Done")
    except Exception as error:
        print("✖", error, file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
