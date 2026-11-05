"""Python port of packages/sdk/examples/diffusion-txt2vid-wan22.ts.

Text-to-video with Wan 2.2 TI2V-5B Turbo (Q5_K_S). Like Wan 2.1 this is a
split layout -- diffusion model + UMT5-XXL text encoder + VAE -- but it needs
the Wan 2.2 VAE specifically: its 16x spatial compression is what gives TI2V
its 32-pixel grid, and the Wan 2.1 VAE is not interchangeable.

TI2V-5B is a single-expert model. The high_noise_* / moe_boundary fields
belong to the two-expert Wan 2.2 A14B layout and are rejected here.

Budget at least 16 GB of video memory or 20 GB of unified memory. The
artifacts total roughly 16.4 GB, dominated by the fp16 text encoder.

The text encoder is byte-identical to the Wan 2.1 repackage, so both
generations share the one UMT5_XXL_FP16 registry entry.

TypeScript's `video()` hands back three channels -- `progressStream`, `outputs`
and `stats`. Python exposes one async iterator instead, and each `video_stream`
response carries whichever of those three it is: `step` with `total_steps`
while denoising, base64 `data` for a finished clip, and `done` with `stats` at
the end.

RUN: python examples/diffusion_txt2vid_wan22.py [diffusion-src] [t5-src] [vae-src] [prompt] [output-dir]
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
    UMT5_XXL_FP16,
    WAN2_2_TI2V_5B_Q5_K_S,
    WAN_2_2_COMFYUI_REPACKAGED_VAE,
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
    diffusion_model_src = sys.argv[1] if len(sys.argv) > 1 else WAN2_2_TI2V_5B_Q5_K_S
    t5_xxl_model_src = sys.argv[2] if len(sys.argv) > 2 else UMT5_XXL_FP16
    vae_model_src = sys.argv[3] if len(sys.argv) > 3 else WAN_2_2_COMFYUI_REPACKAGED_VAE
    # Prompt tip: Turbo responds well to explicit camera and lighting direction.
    # Describe continuous motion rather than a pose, or the clip reads as a
    # still.
    prompt = (
        sys.argv[4]
        if len(sys.argv) > 4
        else (
            "A single white porcelain espresso cup on a dark walnut table beside "
            "a sunlit window, delicate steam curling upward, slow circular camera "
            "move, warm morning light, sharp ceramic texture, realistic continuous "
            "motion"
        )
    )
    output_dir = Path(sys.argv[5]) if len(sys.argv) > 5 else Path(".")

    print(
        "▸ Loading Wan 2.2 TI2V-5B Turbo model "
        "(diffusion + UMT5-XXL + Wan 2.2 VAE)..."
    )

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
                    "diffusion_fa": True,
                    "offload_to_cpu": True,
                    "vae_tiling": True,
                },
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")

            print(f'\n▸ Generating video for: "{prompt}"')

            request = VideoStreamRequest.model_validate(
                {
                    "type": "videoStream",
                    "modelId": model_id,
                    "mode": "txt2vid",
                    "prompt": prompt,
                    "negative_prompt": (
                        "flickering, temporal jitter, morphing, duplicated subject, "
                        "warped geometry, distorted anatomy, blurry details, low "
                        "resolution, text, watermark, logo"
                    ),
                    # TI2V-5B requires width and height to be multiples of 32 --
                    # stricter than the multiple of 16 the schema enforces for Wan
                    # generally. Native validation derives this from the loaded
                    # GGUF, so a non-conforming size fails at generation time
                    # rather than at load.
                    # Turbo was trained on this 720p, 24 fps, five-second shape;
                    # 640x352 with 49 frames is a much cheaper way to smoke-test
                    # the pipeline.
                    "width": 1280,
                    "height": 704,
                    # Frame count must satisfy (4*k + 1), k >= 1. At 24 fps:
                    # 49 ~= 2s, 121 ~= 5s (the trained length).
                    "video_frames": 121,
                    "fps": 24,
                    # Turbo is distilled for very short schedules: 4 steps with
                    # guidance effectively disabled. The non-distilled TI2V-5B
                    # wants steps >= 30 and cfg ~5.0 instead.
                    "steps": 4,
                    "cfg_scale": 1.0,
                    "flow_shift": 5.0,
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
                output_path = output_dir / f"wan22_ti2v_t2v_{index}.avi"
                output_path.write_bytes(clip)
                print(f"▸ Saved {output_path}")

            print("\n▸ Stats:", stats.model_dump(exclude_none=True) if stats else None)

            await unload_model(t, model_id)
            print("▸ Done")
    except Exception as error:
        print("✖", error, file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
