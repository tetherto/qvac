"""Python port of packages/sdk/examples/asr/parakeet-ctc-filesystem.ts.

Parakeet CTC transcription from a WAV file. Loads a single GGUF checkpoint
(`PARAKEET_CTC_0_6B_Q8_0` by default) and transcribes the file with the
batch `transcribe` API. Omit the model argument to use the registry constant.

TypeScript's `transcribe()` returns the joined text. Python calls the worker
directly, so `transcribe` yields `TranscribeResponse` frames and the example
joins their `text` itself.

Audio should be 16 kHz mono PCM in a WAV container.

RUN: python examples/transcription_parakeet_ctc.py <wav-file> [parakeet-ctc-gguf]
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import (
    Client,
    TranscribeRequest,
    load_model,
    transcribe,
    unload_model,
)
from tetherto.qvac_sdk.models import PARAKEET_CTC_0_6B_Q8_0


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
            "Usage: python examples/transcription_parakeet_ctc.py <wav-file> "
            "[parakeet-ctc-gguf]",
            file=sys.stderr,
        )
        print(
            "\nIf the model path is omitted, defaults to the registry model.",
            file=sys.stderr,
        )
        return 1
    audio_path = sys.argv[1]
    parakeet_model_src = sys.argv[2] if len(sys.argv) > 2 else PARAKEET_CTC_0_6B_Q8_0

    async with Client() as client:
        t = client.transport
        try:
            print("▸ Loading Parakeet CTC model...")
            model_id = await load_model(
                t,
                model_src=parakeet_model_src,
                model_type="parakeet-transcription",
                on_progress=print_progress,
            )
            print(f"▸ Parakeet CTC model loaded with ID: {model_id}")

            print("▸ Transcribing audio...")
            # audioChunk is a typed chunk, not a bare path: JS's transcribe
            # wrapper turns a string into {type:"filePath"} for you, but Python
            # calls the generated stub directly, so build the chunk explicitly.
            request = TranscribeRequest.model_validate(
                {
                    "type": "transcribe",
                    "modelId": model_id,
                    "audioChunk": {"type": "filePath", "value": audio_path},
                }
            )

            text = ""
            async for response in transcribe(t, request):
                if response.text:
                    text += response.text

            print(text)

            print("▸ Unloading model...")
            await unload_model(t, model_id)
            print("▸ Done")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
