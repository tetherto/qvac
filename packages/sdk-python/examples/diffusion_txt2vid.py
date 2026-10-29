"""Python port of packages/sdk/examples/diffusion-txt2vid.ts.

Text-to-video with Wan 2.1 T2V 1.3B, which uses a split layout: the diffusion
model, a UMT5-XXL text encoder and a VAE are three separate files handed to one
`load_model` call.

This example needs powerful hardware: at least 16 GB of video memory or 20 GB
of unified memory.

TypeScript's `video()` hands back three channels -- `progressStream`, `outputs`
and `stats`. Python exposes one async iterator instead, and each `video_stream`
response carries whichever of those three it is: `step` with `total_steps`
while denoising, base64 `data` for a finished clip, and `done` with `stats` at
the end. The loop below therefore demultiplexes what TypeScript receives
pre-split, the same way `diffusion_flux2_klein.py` does for images.

RUN: python examples/diffusion_txt2vid.py [diffusion-src] [t5-src] [vae-src] [prompt] [output-dir]
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
    WAN2_1_T2V_1_3B_FP16,
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
    # Wan 2.1 uses a split layout: diffusion model + UMT5-XXL text encoder + VAE
    diffusion_model_src = sys.argv[1] if len(sys.argv) > 1 else WAN2_1_T2V_1_3B_FP16
    t5_xxl_model_src = sys.argv[2] if len(sys.argv) > 2 else UMT5_XXL_FP16
    vae_model_src = sys.argv[3] if len(sys.argv) > 3 else WAN_2_1_COMFYUI_REPACKAGED_VAE
    # Prompt tip: Wan 1.3B is small and has weak temporal priors. Use motion-
    # explicit verbs and avoid static framing words like "standing", "still",
    # or "portrait" in the positive prompt.
    prompt = sys.argv[4] if len(sys.argv) > 4 else "a colorful bird flapping its wings"
    output_dir = Path(sys.argv[5]) if len(sys.argv) > 5 else Path(".")

    print("▸ Loading Wan 2.1 T2V model (diffusion + UMT5-XXL + VAE)...")

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
                "params_backend": "vae=cpu",
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
                "negative_prompt": "blurry, low quality, static, jittery, watermark",
                "width": 480,
                "height": 832,
                # Frame count must satisfy (4*k + 1), k >= 1. Common values at
                # 16 fps:
                # 17 frames ~= 1.06s (very fast, ~6 min on M3 Ultra Metal)
                # 33 frames ~= 2.06s (default in this example, ~11 min)
                # 49 frames ~= 3.06s (~17 min)
                # 65 frames ~= 4.06s (~22 min)
                # 81 frames ~= 5.06s (Wan 1.3B native training length, best
                # motion quality, ~28 min)
                # Going beyond 81 can degrade quality because it exceeds the
                # model's positional embeddings.
                "video_frames": 33,
                "fps": 16,
                "steps": 30,
                "cfg_scale": 6.0,
                # Wan 2.1 T2V needs flow_shift=3.0 for visible motion. Higher
                # values can make consecutive frames near-identical, which
                # looks like a frozen video.
                "flow_shift": 3.0,
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
            output_path = output_dir / f"wan_t2v_{index}.avi"
            output_path.write_bytes(clip)
            print(f"▸ Saved {output_path}")

        print("\n▸ Stats:", stats.model_dump(exclude_none=True) if stats else None)

        await unload_model(t, model_id)

    print("▸ Done")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
