"""Python port of packages/sdk/examples/diffusion-esrgan-upscale.ts.

ESRGAN post-processing: the upscaler is attached to the diffusion model at
`load_model` time via `model_config["upscaler"]`, then triggered per
generation with the request's `upscale` field. Two generations run from the
same seed and prompt -- one single pass (x4) and one two-pass (x16) -- so the
only difference between them is `upscale`.

The ESRGAN constant goes inside `model_config`, not as the top-level
`model_src`, and needs no conversion: `load_model` reduces every model
descriptor it finds anywhere in the config to its `src` string.

Like the other diffusion examples, this one demultiplexes the single
`diffusion_stream` iterator into the per-step progress, the finished images
and the closing stats that TypeScript receives as three separate channels.

RUN: python examples/diffusion_esrgan_upscale.py [esrgan-src] [prompt] [output-dir]
"""

from __future__ import annotations

import asyncio
import base64
import sys
from pathlib import Path

from tetherto.qvac_sdk import (
    Client,
    DiffusionStreamRequest,
    diffusion_stream,
    load_model,
    unload_model,
)
from tetherto.qvac_sdk.models import REALESRGAN_X4PLUS_ANIME_6B, SD_V2_1_1B_Q8_0


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
    esrgan_model_src = sys.argv[1] if len(sys.argv) > 1 else REALESRGAN_X4PLUS_ANIME_6B
    prompt = (
        sys.argv[2]
        if len(sys.argv) > 2
        else "an illustrated red fox portrait, clean line art, "
        "soft watercolor background, detailed fur, crisp eyes"
    )
    negative_prompt = "blurry, low quality, watermark, text"
    output_dir = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(".")
    seed = 42

    print("▸ Loading SD 2.1 + ESRGAN upscaler...")

    async with Client() as client:
        t = client.transport

        model_id = await load_model(
            t,
            model_src=SD_V2_1_1B_Q8_0,
            model_type="sdcpp-generation",
            model_config={
                "prediction": "v",
                "upscaler": {
                    "type": "esrgan",
                    "model_src": esrgan_model_src,
                    "tile_size": 128,
                },
            },
            on_progress=print_progress,
        )
        print(f"▸ Model loaded: {model_id}")

        # Source size is intentionally small -- each ESRGAN repeat multiplies
        # dimensions.
        base_params = {
            "type": "diffusionStream",
            "modelId": model_id,
            "prompt": prompt,
            "negative_prompt": negative_prompt,
            "width": 128,
            "height": 128,
            "steps": 5,
            "cfg_scale": 7.5,
            "seed": seed,
        }

        print(f'▸ Generating ESRGAN x4 upscale: "{prompt}"')
        single = DiffusionStreamRequest.model_validate({**base_params, "upscale": True})

        single_images: list[bytes] = []
        single_stats = None
        async for response in diffusion_stream(t, single):
            if response.step is not None and response.total_steps is not None:
                print(f"▸ step {response.step:.0f}/{response.total_steps:.0f}")
            if response.data is not None:
                single_images.append(base64.b64decode(response.data))
            if response.done:
                single_stats = response.stats

        for index, image in enumerate(single_images):
            output_path = output_dir / f"sd2_esrgan_x4_seed{seed}_{index}.png"
            output_path.write_bytes(image)
            print(f"▸ Saved {output_path}")

        print(
            "▸ Stats:",
            single_stats.model_dump(exclude_none=True) if single_stats else None,
        )

        print("▸ Generating ESRGAN two-pass x16 upscale...")
        two_pass = DiffusionStreamRequest.model_validate(
            {**base_params, "upscale": {"repeats": 2}}
        )

        two_pass_images: list[bytes] = []
        two_pass_stats = None
        async for response in diffusion_stream(t, two_pass):
            if response.step is not None and response.total_steps is not None:
                print(f"▸ step {response.step:.0f}/{response.total_steps:.0f}")
            if response.data is not None:
                two_pass_images.append(base64.b64decode(response.data))
            if response.done:
                two_pass_stats = response.stats

        for index, image in enumerate(two_pass_images):
            output_path = output_dir / f"sd2_esrgan_x16_seed{seed}_{index}.png"
            output_path.write_bytes(image)
            print(f"▸ Saved {output_path}")

        print(
            "▸ Stats:",
            two_pass_stats.model_dump(exclude_none=True) if two_pass_stats else None,
        )

        await unload_model(t, model_id, clear_storage=False)

    print("▸ Done")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
