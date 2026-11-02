"""Python port of packages/sdk/examples/diffusion-simple.ts.

Minimal diffusion example -- single GGUF model, no companion files needed.
Works with SD 1.x / 2.x all-in-one models.

TypeScript reads the finished image off the `outputs` promise that
`diffusion()` returns. Python has only the `diffusion_stream` iterator, so the
image arrives as a base64 chunk on the stream. Everything else the stream
carries -- per-step progress, closing stats -- is ignored here, exactly as the
TypeScript example ignores the channels it does not destructure.

RUN: python examples/diffusion_simple.py [model-src] [prompt]
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
from tetherto.qvac_sdk.models import SD_V2_1_1B_Q8_0


async def main() -> int:
    model_src = sys.argv[1] if len(sys.argv) > 1 else SD_V2_1_1B_Q8_0
    prompt = (
        sys.argv[2] if len(sys.argv) > 2 else "a photo of a cat sitting on a windowsill"
    )

    async with Client() as client:
        t = client.transport

        model_id = await load_model(
            t,
            model_src=model_src,
            model_type="sdcpp-generation",
            model_config={"prediction": "v"},
        )

        request = DiffusionStreamRequest.model_validate(
            {"type": "diffusionStream", "modelId": model_id, "prompt": prompt}
        )

        images: list[bytes] = []
        async for response in diffusion_stream(t, request):
            if response.data is not None:
                images.append(base64.b64decode(response.data))

        Path("output.png").write_bytes(images[0])
        print("▸ Saved output.png")

        await unload_model(t, model_id)

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
