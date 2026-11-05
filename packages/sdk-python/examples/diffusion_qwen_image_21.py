"""Python port of packages/sdk/examples/diffusion-qwen-image-21.ts.

Qwen-Image-2.1 in split layout: a diffusion model, a Qwen3-VL LLM text
encoder, its vision projector and the 2.1 VAE, all handed to one `load_model`
call. Two reference images go in order through `init_images`, and the prompt
asks for an RGBA image with a transparent background.

TypeScript's `diffusion()` takes each reference as raw bytes and base64-encodes
them on the way to the worker. Python calls the worker directly through
`diffusion_stream`, where `init_images` is already a list of encoded strings,
so the example encodes the files itself. The same iterator then carries
progress, the finished images and the closing stats, which TypeScript receives
as three separate channels.

The defaults download pinned Hugging Face weights. Model overrides accept local
paths or URLs.
Model terms: https://huggingface.co/Qwen/Qwen-Image-2.1/blob/d26bb61231c349cf6b7896fa83353113880e1ba3/LICENSE

RUN: python examples/diffusion_qwen_image_21.py <reference-a> <reference-b> [prompt] [output-dir] [model] [llm] [vae] [projector]
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
ENCODER_REPO = f"{HF}/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/f982a07559d4a2f6c8744d840bf6fccab30eea96"
DIFFUSION_MODEL_SRC = (
    f"{HF}/leejet/Qwen-Image-2.1-GGUF/resolve/"
    "cc11433936a06e9765f7c0c0b1f0436cfd2b9856/qwen_image_2.1-Q4_K.gguf"
)
LLM_MODEL_SRC = f"{ENCODER_REPO}/Qwen3VL-8B-Instruct-Q4_K_M.gguf"
VAE_MODEL_SRC = (
    f"{HF}/Comfy-Org/Qwen-Image-2.1/resolve/"
    "a8342359c61979b06a8dafb1a47991fe1f30e994/vae/qwen_image_2.1_vae_bf16.safetensors"
)
PROJECTION_MODEL_SRC = f"{ENCODER_REPO}/mmproj-Qwen3VL-8B-Instruct-F16.gguf"
DEFAULT_PROMPT = (
    "Place the subjects from both reference images side by side. "
    "Generate an RGBA image with a transparent background and no scenery."
)
USAGE = (
    "Usage: python examples/diffusion_qwen_image_21.py <referenceA> <referenceB> "
    "[prompt] [outputDir] [model] [llm] [vae] [projector]"
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
            "▸ The default prompt combines both subjects on a transparent background."
        )
        return 0

    reference_path_a = sys.argv[1] if len(sys.argv) > 1 else None
    reference_path_b = sys.argv[2] if len(sys.argv) > 2 else None
    prompt = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else DEFAULT_PROMPT
    output_dir = Path(sys.argv[4]) if len(sys.argv) > 4 else Path(".")
    diffusion_model_src = sys.argv[5] if len(sys.argv) > 5 else DIFFUSION_MODEL_SRC
    llm_model_src = sys.argv[6] if len(sys.argv) > 6 else LLM_MODEL_SRC
    vae_model_src = sys.argv[7] if len(sys.argv) > 7 else VAE_MODEL_SRC
    projection_model_src = sys.argv[8] if len(sys.argv) > 8 else PROJECTION_MODEL_SRC

    if not reference_path_a or not reference_path_b:
        print("✖ two reference image paths are required", file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 1

    async with Client() as client:
        t = client.transport
        model_id = None

        try:
            init_images = [
                base64.b64encode(Path(path).read_bytes()).decode("ascii")
                for path in (reference_path_a, reference_path_b)
            ]

            print("▸ Loading Qwen-Image-2.1 split-layout model...")
            model_id = await load_model(
                t,
                model_src=model_source(diffusion_model_src),
                model_type="sdcpp-generation",
                model_config={
                    "llmModelSrc": model_source(llm_model_src),
                    "vaeModelSrc": model_source(vae_model_src),
                    "projectionModelSrc": model_source(projection_model_src),
                    "flash_attn": True,
                },
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")
            print(
                f'▸ Generating from "{reference_path_a}" and "{reference_path_b}": "{prompt}"'
            )

            request = DiffusionStreamRequest.model_validate(
                {
                    "type": "diffusionStream",
                    "modelId": model_id,
                    "prompt": prompt,
                    "init_images": init_images,
                    "width": 512,
                    "height": 512,
                    "steps": 30,
                    "cfg_scale": 6,
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
                raise RuntimeError("Qwen-Image-2.1 returned no image.")
            for index, image in enumerate(images):
                output_path = output_dir / f"qwen_image_21_{index}.png"
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
