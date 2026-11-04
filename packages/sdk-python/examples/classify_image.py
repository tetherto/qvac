"""Python port of packages/sdk/examples/classification/classify-image.ts.

Classify an image with MobileNetV3-Small, which produces three classes:
"food", "report", "other".

JS's `classify` base64-encodes the image and returns the results; Python calls
the generated stub, so the request carries the base64 image and the results
are read off the final frame.

RUN: python examples/classify_image.py <image-path>
"""

from __future__ import annotations

import asyncio
import base64
import sys
from pathlib import Path

from tetherto.qvac_sdk import (
    ClassifyRequest,
    Client,
    classify,
    load_model,
    unload_model,
)
from tetherto.qvac_sdk.models import MOBILENETV3_3CLASS_V3_FP16


async def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python examples/classify_image.py <image-path>", file=sys.stderr)
        return 1

    image_path = sys.argv[1]

    async with Client() as client:
        t = client.transport
        try:
            model_id = await load_model(
                t,
                model_src=MOBILENETV3_3CLASS_V3_FP16,
                model_type="ggml-classification",
            )

            image = Path(image_path).read_bytes()
            request = ClassifyRequest.model_validate(
                {
                    "type": "classify",
                    "modelId": model_id,
                    "image": base64.b64encode(image).decode("ascii"),
                }
            )

            results = []
            async for response in classify(t, request):
                if response.done:
                    results = response.results

            print("Classification results:")
            for result in results:
                print(f"  {result.label}: {result.confidence * 100:.1f}%")

            await unload_model(t, model_id)
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
