"""Python port of packages/sdk/examples/diffusion-ideogram.ts.

Ideogram 4 in split layout: a diffusion model, an unconditional diffusion
model, a Qwen3-VL LLM text encoder and a VAE, all handed to one `load_model`
call. Its `prompt` is not prose but a serialized structured caption, with a
bounding box per element in the target canvas coordinate space.

Two Python-specific details. `json.dumps` pads with spaces by default while
`JSON.stringify` emits none, so `separators` keeps the serialized caption
byte-identical to what the TypeScript example sends -- the model is sensitive
to this format. And `diffusion_stream` is one iterator where TypeScript's
`diffusion()` returns separate progress, output and stats channels, so the
loop below splits them apart.

RUN: python examples/diffusion_ideogram.py [model] [uncond] [llm] [vae] [output-dir]
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import sys
from pathlib import Path

from tetherto.qvac_sdk import (
    Client,
    DiffusionStreamRequest,
    diffusion_stream,
    load_model,
    unload_model,
)

DIFFUSION_MODEL_SRC = (
    "https://huggingface.co/leejet/ideogram-4-GGUF/resolve/main/ideogram4-Q4_0.gguf"
)
UNCOND_MODEL_SRC = "https://huggingface.co/leejet/ideogram-4-GGUF/resolve/main/ideogram4_uncond-Q4_0.gguf"
LLM_MODEL_SRC = "https://huggingface.co/unsloth/Qwen3-VL-8B-Instruct-GGUF/resolve/main/Qwen3-VL-8B-Instruct-Q4_K_M.gguf"
VAE_MODEL_SRC = "https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors"

# Ideogram 4 expects a JSON-serialized structured caption with explicit
# bounding boxes. Plain-text prompts produce degenerate or placeholder output.
STRUCTURED_PROMPT = {
    "high_level_description": "A bright product photo of one yellow coffee mug on a clean office desk with a tiny readable label that says IDEO.",
    "style_description": {
        "aesthetics": "simple product photography, clean bright office desk, minimal composition",
        "lighting": "soft studio light with gentle shadows",
        "photo": "sharp focus, crisp readable label text",
        "medium": "product photo",
        "color_palette": ["#FFD54A", "#FFFFFF", "#111111", "#7EC8E3"],
    },
    "compositional_deconstruction": {
        "canvas": "Square canvas, upright orientation. All text is horizontal and readable.",
        "background": "Clean white office desk with a soft blue background gradient.",
        "elements": [
            {
                "type": "obj",
                "bbox": [230, 260, 800, 740],
                "desc": "Exactly one matte yellow ceramic coffee mug centered on the desk.",
            },
            {
                "type": "text",
                "bbox": [510, 360, 620, 640],
                "text": "IDEO",
                "desc": "Small black label printed horizontally on the mug.",
            },
        ],
    },
}


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
        print(
            "Usage: python examples/diffusion_ideogram.py "
            "[model] [uncond] [llm] [vae] [output-dir]"
        )
        print(
            "▸ Defaults use the four Hugging Face model URLs supported by the "
            "diffusion addon."
        )
        return 0

    diffusion_model_src = sys.argv[1] if len(sys.argv) > 1 else DIFFUSION_MODEL_SRC
    uncond_model_src = sys.argv[2] if len(sys.argv) > 2 else UNCOND_MODEL_SRC
    llm_model_src = sys.argv[3] if len(sys.argv) > 3 else LLM_MODEL_SRC
    vae_model_src = sys.argv[4] if len(sys.argv) > 4 else VAE_MODEL_SRC
    output_dir = Path(sys.argv[5]) if len(sys.argv) > 5 else Path(".")

    async with Client() as client:
        t = client.transport
        model_id = None

        try:
            print("▸ Loading Ideogram 4 split-layout model...")
            model_id = await load_model(
                t,
                model_src=diffusion_model_src,
                model_type="sdcpp-generation",
                model_config={
                    "device": "gpu",
                    "threads": 4,
                    "diffusion_fa": True,
                    "offload_to_cpu": True,
                    "llmModelSrc": llm_model_src,
                    "vaeModelSrc": vae_model_src,
                    "uncondModelSrc": uncond_model_src,
                },
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")

            request = DiffusionStreamRequest.model_validate(
                {
                    "type": "diffusionStream",
                    "modelId": model_id,
                    # Compact separators match JSON.stringify; the model is
                    # sensitive to the caption's exact format.
                    "prompt": json.dumps(STRUCTURED_PROMPT, separators=(",", ":")),
                    "width": 768,
                    "height": 768,
                    "steps": 16,
                    "cfg_scale": 7,
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

            for index, image in enumerate(images):
                output_path = output_dir / f"ideogram_{index}.png"
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
