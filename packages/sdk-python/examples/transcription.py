"""Python port of packages/sdk/examples/transcription/whispercpp-filesystem.ts.

Transcribe an audio file with per-segment metadata. `transcribe` is a
server-stream: it yields `TranscribeResponse` frames; with `metadata=True`
each carries a `segment` ({text, start_ms, end_ms, append, id}).

Pass a 16 kHz mono WAV path, e.g. the SDK's own sample:
  python examples/transcription.py \
    ../sdk/examples/audio/sample-16khz.wav
"""

from __future__ import annotations

import asyncio
import sys

from _common import print_progress

from tetherto.qvac_sdk import (
    Client,
    TranscribeRequest,
    load_model,
    transcribe,
    unload_model,
)
from tetherto.qvac_sdk.models import WHISPER_TINY


async def main() -> int:
    if len(sys.argv) < 2:
        print(
            "Usage: python examples/transcription.py <wav-file-path>", file=sys.stderr
        )
        return 1
    audio_path = sys.argv[1]

    async with Client() as client:
        t = client.transport
        try:
            print("▸ Loading Whisper model...")
            model_id = await load_model(
                t,
                model_src=WHISPER_TINY,
                model_config={"audio_format": "f32le", "language": "en"},
                on_progress=print_progress,
            )
            print(f"▸ Whisper model loaded with ID: {model_id}")

            print("▸ Transcribing audio...")
            # audioChunk is a typed chunk, not a bare path: JS's transcribe
            # wrapper turns a string into {type:"filePath"} for you, but Python
            # calls the generated stub directly, so build the chunk explicitly.
            request = TranscribeRequest.model_validate(
                {
                    "type": "transcribe",
                    "modelId": model_id,
                    "audioChunk": {"type": "filePath", "value": audio_path},
                    "metadata": True,
                }
            )

            segments = []
            async for response in transcribe(t, request):
                if response.segment is not None:
                    segments.append(response.segment)

            print("▸ Transcription result:")
            for seg in segments:
                start = seg.start_ms / 1000
                end = seg.end_ms / 1000
                print(
                    f"  [{start:.2f}s → {end:.2f}s] (id={seg.id}, append={seg.append}) {seg.text}"
                )
            print("\nFull transcript:", "".join(s.text for s in segments).strip())

            print("▸ Unloading Whisper model...")
            await unload_model(t, model_id)
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
