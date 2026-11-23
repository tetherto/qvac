"""Python port of packages/sdk/examples/diffusion-moss-image.ts.

MOSS-Image in split layout: a diffusion model, a Qwen3.5 LLM text encoder,
a VAE and the encoder's external `tokenizer.json`, all handed to one
`load_model` call. Its `prompt` here is a serialized JSON layout that places
text and objects with boxes in centred pixel coordinates.

`json.dumps` escapes non-ASCII text and pads with spaces by default, while
`JSON.stringify` does neither, so `ensure_ascii=False` and `separators` keep the
serialized layout identical to what the TypeScript example sends -- escaped
text would reach the model as `\\uXXXX` rather than the characters to render.
`diffusion_stream` is one iterator where TypeScript's
`diffusion()` returns separate progress, output and stats channels, so the
loop below splits them apart.

RUN: python examples/diffusion_moss_image.py [output-dir] [model] [llm] [vae] [tokenizer]
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
from tetherto.qvac_sdk.models import (
    MOSS_IMAGE_SFT_5B_BF16,
    MOSS_IMAGE_SFT_TOKENIZER,
    MOSS_IMAGE_VAE,
    QWEN3_5_9B_MULTIMODAL_Q4_K_M,
)

WIDTH = 1024
HEIGHT = 1024

# Boxes are [y_min, x_min, y_max, x_max] in absolute pixels with the canvas
# centre as the origin, so a 1024x1024 canvas spans -512..512 on both axes.
# Keep them consistent with WIDTH and HEIGHT.
LAYOUT = {
    "summary": {
        "meta": ["poster"],
        "canvas": "single",
        "caption": "A minimalist travel poster of a snowy mountain at sunrise, flat illustration style.",
    },
    "items": [
        {
            "label": "text",
            "caption": "Bold white sans-serif title across the top of the poster.",
            "text": "SUMMIT",
            "bbox": [-448, -352, -320, 352],
        },
        {
            "label": "object",
            "caption": "A snowy mountain peak lit by an orange sunrise.",
            "bbox": [-224, -320, 384, 320],
        },
    ],
    "bbox_coord_space": "abs_centralized",
    "bbox_format": "yxyx",
}


def model_source(source: str) -> str:
    """Pass URLs through; resolve local paths to absolute ones."""
    if source.startswith(("http://", "https://")):
        return source
    return str(Path(source).resolve())


_last_percent: dict[str, int] = {}


def print_progress(p) -> None:
    """Print model download progress; pass as `on_progress=` to `load_model`.

    Progress fires many times per percent on a multi-GB download, so it prints
    once per whole percent of each file.
    """
    percent = int(p.percentage)
    if _last_percent.get(p.download_key) == percent:
        return
    _last_percent[p.download_key] = percent
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
            "Usage: python examples/diffusion_moss_image.py "
            "[output-dir] [model] [llm] [vae] [tokenizer]"
        )
        print(
            "▸ Defaults download the MOSS-Image registry models. "
            "Model overrides accept paths or URLs."
        )
        return 0

    output_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
    diffusion_model_src = (
        model_source(sys.argv[2]) if len(sys.argv) > 2 else MOSS_IMAGE_SFT_5B_BF16
    )
    llm_model_src = (
        model_source(sys.argv[3]) if len(sys.argv) > 3 else QWEN3_5_9B_MULTIMODAL_Q4_K_M
    )
    vae_model_src = model_source(sys.argv[4]) if len(sys.argv) > 4 else MOSS_IMAGE_VAE
    tokenizer_src = (
        model_source(sys.argv[5]) if len(sys.argv) > 5 else MOSS_IMAGE_SFT_TOKENIZER
    )

    async with Client() as client:
        t = client.transport
        model_id = None

        try:
            print("▸ Loading MOSS-Image...")
            model_id = await load_model(
                t,
                model_src=diffusion_model_src,
                model_type="sdcpp-generation",
                model_config={
                    "llmModelSrc": llm_model_src,
                    "vaeModelSrc": vae_model_src,
                    "tokenizerSrc": tokenizer_src,
                    "flash_attn": True,
                },
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")

            request = DiffusionStreamRequest.model_validate(
                {
                    "type": "diffusionStream",
                    "modelId": model_id,
                    "prompt": json.dumps(
                        LAYOUT, ensure_ascii=False, separators=(",", ":")
                    ),
                    "width": WIDTH,
                    "height": HEIGHT,
                    "steps": 50,
                    "cfg_scale": 3,
                    "sampling_method": "euler",
                    "scheduler": "discrete",
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
                raise RuntimeError("MOSS-Image returned no image.")
            for index, image in enumerate(images):
                output_path = output_dir / f"moss_image_{index}.png"
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
