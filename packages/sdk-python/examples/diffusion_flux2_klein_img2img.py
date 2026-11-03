"""Python port of packages/sdk/examples/diffusion-flux2-klein-img2img.ts.

img2img with FLUX.2 [klein] split-layout -- uses in-context conditioning
("flux2_flow").

TypeScript's `diffusion()` takes `init_image` as raw bytes and base64-encodes
them on the way to the worker. Python calls the worker directly through
`diffusion_stream`, where `init_image` is already the encoded string, so the
example encodes the file itself. The same iterator then carries progress, the
finished images and the closing stats, which TypeScript receives as three
separate channels.

No `width`/`height` is passed, so the generation runs at the input image's
size. A large input therefore means much more work per step.

RUN: python examples/diffusion_flux2_klein_img2img.py <input-image> [prompt] [output-dir] [diffusion-src] [llm-src] [vae-src]
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
from tetherto.qvac_sdk.models import (
    FLUX_2_KLEIN_4B_Q4_0,
    FLUX_2_KLEIN_4B_VAE,
    QWEN3_4B_Q4_K_M,
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
    input_path = sys.argv[1] if len(sys.argv) > 1 else None
    prompt = sys.argv[2] if len(sys.argv) > 2 else "oil painting style, vibrant colors"
    output_dir = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(".")
    diffusion_model_src = sys.argv[4] if len(sys.argv) > 4 else FLUX_2_KLEIN_4B_Q4_0
    llm_model_src = sys.argv[5] if len(sys.argv) > 5 else QWEN3_4B_Q4_K_M
    vae_model_src = sys.argv[6] if len(sys.argv) > 6 else FLUX_2_KLEIN_4B_VAE

    if not input_path:
        print("✖ input image path is required", file=sys.stderr)
        print(
            "Usage: python examples/diffusion_flux2_klein_img2img.py <inputImage> "
            "[prompt] [outputDir] [diffusionModelSrc] [llmModelSrc] [vaeModelSrc]",
            file=sys.stderr,
        )
        return 1

    try:
        async with Client() as client:
            t = client.transport

            print("▸ Loading FLUX.2 [klein] split-layout model...")
            model_id = await load_model(
                t,
                model_src=diffusion_model_src,
                model_type="sdcpp-generation",
                model_config={
                    "device": "gpu",
                    "threads": 4,
                    "llmModelSrc": llm_model_src,
                    "vaeModelSrc": vae_model_src,
                    "prediction": "flux2_flow",
                },
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")

            init_image = base64.b64encode(Path(input_path).read_bytes()).decode("ascii")
            print(f'▸ Transforming "{input_path}" with prompt: "{prompt}"')

            request = DiffusionStreamRequest.model_validate(
                {
                    "type": "diffusionStream",
                    "modelId": model_id,
                    "prompt": prompt,
                    "init_image": init_image,
                    "steps": 20,
                    "guidance": 3.5,
                    "cfg_scale": 1,
                    "seed": -1,
                }
            )

            images: list[bytes] = []
            stats = None
            async for response in diffusion_stream(t, request):
                if response.step is not None and response.total_steps is not None:
                    print(f"▸ step {response.step:.0f}/{response.total_steps:.0f}")
                if response.data is not None:
                    images.append(base64.b64decode(response.data))
                if response.done:
                    stats = response.stats

            for index, image in enumerate(images):
                output_path = output_dir / f"flux2_img2img_{index}.png"
                output_path.write_bytes(image)
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
