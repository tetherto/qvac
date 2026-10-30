"""Python port of packages/sdk/examples/bci/bci-filesystem.ts.

Batch BCI transcription from a neural-signal file.

Reads a raw neural-signal `.bin` file, runs it through the BCI (whisper.cpp)
addon in one shot via `bci_transcribe`, and prints the decoded transcript.

JS's `bciTranscribe` takes a bare path and returns the segments; Python calls
the generated stub, so the request carries a typed `{"type": "filePath"}`
chunk and the segments are read off the streamed frames.

RUN: python examples/bci_filesystem.py <neural-bin-file-path>
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import (
    BciTranscribeRequest,
    Client,
    bci_transcribe,
    load_model,
    unload_model,
)
from tetherto.qvac_sdk.models import BCI_WINDOWED


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
            "Usage: python examples/bci_filesystem.py <neural-bin-file-path>",
            file=sys.stderr,
        )
        return 1

    neural_file_path = sys.argv[1]

    async with Client() as client:
        t = client.transport
        try:
            print("▸ Starting BCI transcription example...")

            print("▸ Loading BCI model...")
            model_id = await load_model(
                t,
                model_src=BCI_WINDOWED,
                model_config={
                    "whisperConfig": {
                        "language": "en",
                        "n_threads": 4,
                        "temperature": 0.0,
                    },
                    # Session day index selects the day-specific projection
                    # matrices. Set this to match the recording session your
                    # neural file came from.
                    "bciConfig": {"day_idx": 1},
                },
                on_progress=print_progress,
            )
            print(f"▸ BCI model loaded with ID: {model_id}")

            print("▸ Transcribing neural signal...")
            request = BciTranscribeRequest.model_validate(
                {
                    "type": "bciTranscribe",
                    "modelId": model_id,
                    "neuralData": {"type": "filePath", "value": neural_file_path},
                    "metadata": True,
                }
            )

            segments = []
            async for response in bci_transcribe(t, request):
                if response.error:
                    raise RuntimeError(response.error)
                if response.segment is not None:
                    segments.append(response.segment)

            print("▸ Transcription result:")
            for segment in segments:
                start = f"{segment.start_ms / 1000:.2f}"
                end = f"{segment.end_ms / 1000:.2f}"
                print(
                    f"  [{start}s → {end}s] (id={segment.id:g}, "
                    f"append={str(segment.append).lower()}) {segment.text}"
                )
            print("".join(s.text for s in segments).strip())

            print("▸ Unloading BCI model...")
            await unload_model(t, model_id)
            print("▸ BCI model unloaded successfully")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
