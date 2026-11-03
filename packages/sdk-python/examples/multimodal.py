"""Multimodal completion — Python port of
packages/sdk/examples/llamacpp-multimodal.ts.

Load a multimodal LLM together with its matching projection model, then hang
`attachments` off a user turn: one image first, then both images in a single
request so the model can compare them.

RUN: python examples/multimodal.py <image path> [<second image path>]
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import Client, completion, load_model, unload_model
from tetherto.qvac_sdk.models import (
    MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
    SMOLVLM2_500M_MULTIMODAL_Q8_0,
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
    if len(sys.argv) < 2:
        print(
            "▸ Specify an image file path as the first argument and a second "
            "image file path as the second (optional) argument",
            file=sys.stderr,
        )
        return 1

    image_file_path = sys.argv[1]

    async with Client() as client:
        t = client.transport
        try:
            # Load the main model with projection in a single step
            model_id = await load_model(
                t,
                model_src=SMOLVLM2_500M_MULTIMODAL_Q8_0,
                model_config={
                    # An image is tiled into hundreds of context units before a
                    # single word of the prompt is counted, and the comparison
                    # below sends two at once.
                    "ctx_size": 8192,
                    "projectionModelSrc": MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
                },
                on_progress=print_progress,
            )

            # Using one particular media
            history = [
                {
                    "role": "user",
                    "content": "What's in this image?",
                    "attachments": [{"path": image_file_path}],
                }
            ]
            run = completion(t, model_id=model_id, history=history, stream=True)

            async for event in run.events:
                if event.type == "contentDelta":
                    sys.stdout.write(event.text)
                    sys.stdout.flush()

            final = await run.final
            print("\n▸ Performance Stats:", final.stats)
            print("▸ --------------------------------")

            # Using multiple media
            if len(sys.argv) < 3:
                print("▸ Only one image provided, terminating")
                return 0

            image_file_path2 = sys.argv[2]

            history2 = [
                {
                    "role": "user",
                    "content": "Compare the two newspaper articles",
                    "attachments": [
                        {"path": image_file_path},
                        {"path": image_file_path2},
                    ],
                }
            ]
            run2 = completion(t, model_id=model_id, history=history2, stream=True)

            async for event in run2.events:
                if event.type == "contentDelta":
                    sys.stdout.write(event.text)
                    sys.stdout.flush()

            final2 = await run2.final
            print("\n▸ Performance Stats:", final2.stats)
            print("▸ --------------------------------")

            await unload_model(t, model_id)
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
