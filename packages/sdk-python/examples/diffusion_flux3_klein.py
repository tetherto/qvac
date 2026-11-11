"""Python port of packages/sdk/examples/diffusion-flux3-klein.ts.

FLUX.3 Image Klein in split layout: a diffusion model, a Qwen3-VL 4B LLM text
encoder and the FLUX.2 VAE, all handed to one `load_model` call. Without
reference images it generates from text; up to 10 reference images passed
after the model arguments go in order through `init_images` for editing.

The defaults download pinned Hugging Face weights. Model overrides accept local
paths or URLs.
FLUX.3 model terms: https://huggingface.co/black-forest-labs/flux-3-image-klein/blob/09561231f44e41381c461caf53d5452005a60ac9/LICENSE.md

TypeScript's `diffusion()` takes each reference as raw bytes and base64-encodes
them on the way to the worker. Python calls the worker directly through
`diffusion_stream`, where `init_images` is already a list of encoded strings,
so the example encodes the files itself.

RUN: python examples/diffusion_flux3_klein.py [prompt] [output-dir] [model] [llm] [vae] [...references]
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import sys
from pathlib import Path

from tetherto.qvac_sdk import (
    Client,
    DiffusionStreamRequest,
    diffusion_stream,
    load_model,
    unload_model,
)

HF = "https://huggingface.co"
DIFFUSION_MODEL_SRC = (
    f"{HF}/leejet/flux-3-image-klein-GGUF/resolve/"
    "1c2ad2f9b9247ccca6506a23bdb033fdb0873321/flux3-image-klein-Q8_0.gguf"
)
LLM_MODEL_SRC = (
    f"{HF}/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/"
    "1cd86afb9a95c410a6038ab3b40d8b578c892266/Qwen3VL-4B-Instruct-Q4_K_M.gguf"
)
VAE_MODEL_SRC = (
    f"{HF}/Comfy-Org/Flux-2-Klein-4B/resolve/"
    "5b3abca5c0dc1ecd4eaf3340868d09063fc1c965/split_files/vae/flux2-vae.safetensors"
)
DEFAULT_PROMPT = "A lovely cat holding a sign that says 'FLUX3'"
USAGE = (
    "Usage: python examples/diffusion_flux3_klein.py "
    "[prompt] [outputDir] [model] [llm] [vae] [...references]"
)


def model_source(source: str) -> str:
    """Pass URLs through; resolve local paths to absolute ones."""
    if source.startswith(("http://", "https://")):
        return source
    return str(Path(source).resolve())


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
    if "--help" in sys.argv:
        print(USAGE)
        print(
            "▸ Defaults download pinned Hugging Face weights. Model overrides accept paths or URLs."
        )
        print(
            "▸ Pass up to 10 reference image paths to edit them instead of generating from text."
        )
        return 0

    prompt = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else DEFAULT_PROMPT
    output_dir = Path(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else Path(".")
    diffusion_model_src = (
        sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else DIFFUSION_MODEL_SRC
    )
    llm_model_src = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else LLM_MODEL_SRC
    vae_model_src = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else VAE_MODEL_SRC
    reference_paths = sys.argv[6:]

    if len(reference_paths) > 10:
        print("✖ FLUX.3 accepts at most 10 reference images", file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 1

    async with Client() as client:
        t = client.transport
        model_id = None

        try:
            init_images = [
                base64.b64encode(Path(path).read_bytes()).decode("ascii")
                for path in reference_paths
            ]

            print("▸ Loading FLUX.3 Image Klein split-layout model...")
            model_id = await load_model(
                t,
                model_src=model_source(diffusion_model_src),
                model_type="sdcpp-generation",
                model_config={
                    "llmModelSrc": model_source(llm_model_src),
                    "vaeModelSrc": model_source(vae_model_src),
                    "flash_attn": True,
                },
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")
            print(f'▸ Generating: "{prompt}"')

            # Recommended settings for the distilled model: 16 Euler steps at CFG 1.
            request = DiffusionStreamRequest.model_validate(
                {
                    "type": "diffusionStream",
                    "modelId": model_id,
                    "prompt": prompt,
                    **({"init_images": init_images} if init_images else {}),
                    "width": 512,
                    "height": 512,
                    "steps": 16,
                    "cfg_scale": 1,
                    "sampling_method": "euler",
                    "seed": 42,
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

            if not images:
                raise RuntimeError("FLUX.3 returned no image.")
            for index, image in enumerate(images):
                output_path = output_dir / f"flux3_{index}.png"
                output_path.write_bytes(image)
                print(f"▸ Saved {output_path}")

            print("▸ Stats:", stats.model_dump(exclude_none=True) if stats else None)

            await unload_model(t, model_id)
            model_id = None
            print("▸ Done")
        except Exception as error:
            if model_id is not None:
                # Preserve the original error.
                with contextlib.suppress(Exception):
                    await unload_model(t, model_id)
            print("✖", error, file=sys.stderr)
            return 1

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
