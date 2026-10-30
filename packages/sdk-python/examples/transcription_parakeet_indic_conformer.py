"""Python port of packages/sdk/examples/asr/parakeet-indic-conformer-filesystem.ts.

Indic Conformer CTC transcription from a WAV file. Loads a single GGUF
checkpoint (`PARAKEET_INDIC_CONFORMER_600M_Q8_0` by default) and transcribes
with the batch `transcribe` API. `language` is required (e.g. `hi`, `ta`)
because Indic Conformer CTC masks the vocab with `parakeet.ctc.lang_*` ranges.
English Parakeet CTC ignores this field.

TypeScript's `transcribe()` returns the joined text. Python calls the worker
directly, so `transcribe` yields `TranscribeResponse` frames and the example
joins their `text` itself.

Audio should be 16 kHz mono PCM in a WAV container.

RUN: python examples/transcription_parakeet_indic_conformer.py <wav-file> <language> [indic-conformer-gguf]
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
from tetherto.qvac_sdk.models import PARAKEET_INDIC_CONFORMER_600M_Q8_0


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
    if len(sys.argv) < 3:
        print(
            "Usage: python examples/transcription_parakeet_indic_conformer.py "
            "<wav-file> <language> [indic-conformer-gguf]",
            file=sys.stderr,
        )
        print(
            "\nExample: ... transcription_parakeet_indic_conformer.py speech.wav hi",
            file=sys.stderr,
        )
        print(
            "If the model path is omitted, defaults to the registry model.",
            file=sys.stderr,
        )
        return 1
    audio_path = sys.argv[1]
    language = sys.argv[2]
    parakeet_model_src = (
        sys.argv[3] if len(sys.argv) > 3 else PARAKEET_INDIC_CONFORMER_600M_Q8_0
    )

    async with Client() as client:
        t = client.transport
        try:
            print("▸ Loading Indic Conformer CTC model...")
            model_id = await load_model(
                t,
                model_src=parakeet_model_src,
                model_type="parakeet-transcription",
                model_config={"language": language},
                on_progress=print_progress,
            )
            print(f"▸ Indic Conformer CTC model loaded with ID: {model_id}")
            print(f"▸ Language: {language}")

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
