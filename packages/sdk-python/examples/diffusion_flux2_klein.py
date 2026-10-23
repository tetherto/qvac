"""Python port of packages/sdk/examples/diffusion-flux2-klein.ts.

Text-to-image with FLUX.2 [klein], which uses a split layout: the diffusion
model, an LLM text encoder and a VAE are three separate files handed to one
`load_model` call.

TypeScript's `diffusion()` hands back three channels -- `progressStream`,
`outputs` and `stats`. Python exposes one async iterator instead, and each
`diffusion_stream` response carries whichever of those three it is: `step`
with `total_steps` while denoising, base64 `data` for a finished image, and
`done` with `stats` at the end. The loop below therefore demultiplexes what
TypeScript receives pre-split, the same way `audiogen.py` does for audio.

RUN: python examples/diffusion_flux2_klein.py [diffusion-src] [llm-src] [vae-src] [prompt] [output-dir]
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
    # FLUX.2 [klein] uses a split-layout: separate diffusion model + LLM text
    # encoder + VAE
    diffusion_model_src = sys.argv[1] if len(sys.argv) > 1 else FLUX_2_KLEIN_4B_Q4_0
    llm_model_src = sys.argv[2] if len(sys.argv) > 2 else QWEN3_4B_Q4_K_M
    vae_model_src = sys.argv[3] if len(sys.argv) > 3 else FLUX_2_KLEIN_4B_VAE
    prompt = (
        sys.argv[4]
        if len(sys.argv) > 4
        else "a futuristic city at sunset, photorealistic"
    )
    output_dir = Path(sys.argv[5]) if len(sys.argv) > 5 else Path(".")

    print("▸ Loading FLUX.2 [klein] split-layout model...")

    async with Client() as client:
        t = client.transport

        model_id = await load_model(
            t,
            model_src=diffusion_model_src,
            model_type="sdcpp-generation",
            model_config={
                "device": "gpu",
                "threads": 4,
                "llmModelSrc": llm_model_src,
                "vaeModelSrc": vae_model_src,
            },
            on_progress=print_progress,
        )
        print(f"▸ Model loaded: {model_id}")

        print(f'▸ Generating: "{prompt}"')

        request = DiffusionStreamRequest.model_validate(
            {
                "type": "diffusionStream",
                "modelId": model_id,
                "prompt": prompt,
                "width": 512,
                "height": 512,
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
            output_path = output_dir / f"flux2_{index}.png"
            output_path.write_bytes(image)
            print(f"▸ Saved {output_path}")

        print("▸ Stats:", stats.model_dump(exclude_none=True) if stats else None)

        await unload_model(t, model_id)

    print("▸ Done")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
