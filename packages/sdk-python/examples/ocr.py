"""Python port of packages/sdk/examples/ocr-fasttext.ts.

Run OCR over an image and print the recognized text blocks. `ocr_stream` is a
server-stream: it yields `OcrStreamResponse` frames, each with a `blocks` list
whose items carry `text` (and, when present, `bbox` / `confidence`).

Pass an image path (BMP/PNG/JPG); the SDK repo ships a sample at
packages/sdk/examples/image/basic_test.bmp, not included in the wheel:
  python examples/ocr.py path/to/image.png
"""

from __future__ import annotations

import asyncio
import sys

from _common import print_progress

from tetherto.qvac_sdk import (
    Client,
    OcrStreamRequest,
    load_model,
    ocr_stream,
    unload_model,
)
from tetherto.qvac_sdk.models import OCR_LATIN


async def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python examples/ocr.py <image-path>", file=sys.stderr)
        return 1
    image_path = sys.argv[1]

    async with Client() as client:
        t = client.transport
        try:
            print("▸ Loading OCR model...")
            model_id = await load_model(
                t,
                model_src=OCR_LATIN,
                model_config={
                    "langList": ["en"],
                    "magRatio": 1.5,
                    "defaultRotationAngles": [90, 180, 270],
                    "contrastRetry": False,
                    "lowConfidenceThreshold": 0.5,
                    "recognizerBatchSize": 1,
                },
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")

            print(f"\n▸ Running OCR on: {image_path}")
            # image is a typed chunk, not a bare path: JS's ocr wrapper turns a
            # string into {type:"filePath"} for you, but Python calls the
            # generated stub directly, so build the chunk explicitly.
            request = OcrStreamRequest.model_validate(
                {
                    "type": "ocrStream",
                    "modelId": model_id,
                    "image": {"type": "filePath", "value": image_path},
                    "options": {"paragraph": False},
                }
            )

            print("\n▸ OCR Results:")
            print("▸ ================================")
            async for response in ocr_stream(t, request):
                for block in response.blocks or []:
                    print(block.text)
                    bbox = getattr(block, "bbox", None)
                    if bbox is not None:
                        print(f"▸ BBox: {bbox}")
                    confidence = getattr(block, "confidence", None)
                    if confidence is not None:
                        print(f"▸ Confidence: {confidence}")
            print("▸ ================================")

            print("\n▸ Unloading model...")
            await unload_model(t, model_id)
            print("▸ Model unloaded successfully.")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
