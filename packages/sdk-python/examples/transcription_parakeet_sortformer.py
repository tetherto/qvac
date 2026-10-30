"""Python port of packages/sdk/examples/asr/parakeet-sortformer.ts.

Parakeet Sortformer diarization + TDT transcription pipeline. Two-step flow:
Sortformer v2.1 diarizes the audio, then TDT transcribes each speaker segment.
Defaults to registry GGUFs. A multi-speaker sample is in the QVAC source repo:
  https://github.com/tetherto/qvac/blob/main/packages/sdk/examples/audio/diarization-sample-16k.wav

TypeScript's `transcribe()` returns the joined text. Python calls the worker
directly, so `transcribe` yields `TranscribeResponse` frames and the example
joins their `text` itself. The standard-library `wave` module reads the PCM
and writes each segment as its own WAV, where TypeScript parses the header by
hand.

Audio should be 16 kHz mono 16-bit PCM in a WAV container.

RUN: python examples/transcription_parakeet_sortformer.py <wav-file> [sortformer-gguf]
"""

from __future__ import annotations

import asyncio
import math
import re
import sys
import tempfile
import wave
from pathlib import Path

from tetherto.qvac_sdk import (
    Client,
    TranscribeRequest,
    load_model,
    transcribe,
    unload_model,
)
from tetherto.qvac_sdk.models import (
    PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0,
    PARAKEET_TDT_0_6B_V3_Q8_0,
)

SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2
SEGMENT_PATTERN = re.compile(r"Speaker (\d+): ([\d.]+)s - ([\d.]+)s")


async def transcribe_file(t, model_id: str, audio_path: str) -> str:
    # audioChunk is a typed chunk, not a bare path: JS's transcribe wrapper
    # turns a string into {type:"filePath"} for you, but Python calls the
    # generated stub directly, so build the chunk explicitly.
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
    return text


def parse_diarization(text: str) -> list[dict]:
    segments = [
        {"speaker": int(m[1]), "start": float(m[2]), "end": float(m[3])}
        for m in SEGMENT_PATTERN.finditer(text)
    ]
    return sorted(segments, key=lambda seg: seg["start"])


def read_pcm(wav_path: str) -> bytes:
    with wave.open(wav_path, "rb") as wav:
        return wav.readframes(wav.getnframes())


def write_wav_slice(
    pcm: bytes, start_sec: float, end_sec: float, out_path: Path
) -> bool:
    start_byte = math.floor(start_sec * SAMPLE_RATE) * BYTES_PER_SAMPLE
    end_byte = min(math.ceil(end_sec * SAMPLE_RATE) * BYTES_PER_SAMPLE, len(pcm))
    if start_byte >= end_byte:
        return False

    with wave.open(str(out_path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(BYTES_PER_SAMPLE)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm[start_byte:end_byte])
    return True


def merge_speakers(entries: list[dict]) -> list[dict]:
    merged: list[dict] = []
    for entry in entries:
        if merged and merged[-1]["speaker"] == entry["speaker"]:
            merged[-1]["text"] += " " + entry["text"]
            merged[-1]["end"] = entry["end"]
        else:
            merged.append(dict(entry))
    return merged


async def main() -> int:
    if len(sys.argv) < 2:
        print(
            "Usage: python examples/transcription_parakeet_sortformer.py <wav-file> "
            "[sortformer-gguf]",
            file=sys.stderr,
        )
        print(
            "\nIf the model path is omitted, defaults to the registry model.",
            file=sys.stderr,
        )
        return 1
    audio_path = sys.argv[1]
    sortformer_src = (
        sys.argv[2] if len(sys.argv) > 2 else PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0
    )

    async with Client() as client:
        t = client.transport
        try:
            # ── Step 1: Diarize with Sortformer ──

            sf_model_id = await load_model(
                t, model_src=sortformer_src, model_type="parakeet-transcription"
            )
            diarization = await transcribe_file(t, sf_model_id, audio_path)
            await unload_model(t, sf_model_id)

            segments = parse_diarization(diarization)

            # ── Step 2: Transcribe each segment with TDT ──

            tdt_model_id = await load_model(
                t,
                model_src=PARAKEET_TDT_0_6B_V3_Q8_0,
                model_type="parakeet-transcription",
            )

            pcm = read_pcm(audio_path)
            results = []
            with tempfile.TemporaryDirectory(prefix="qvac-diarize-") as slice_dir:
                for index, seg in enumerate(segments):
                    slice_path = Path(slice_dir) / f"seg-{index}.wav"

                    if not write_wav_slice(pcm, seg["start"], seg["end"], slice_path):
                        results.append({**seg, "text": "[No speech detected]"})
                        continue

                    text = await transcribe_file(t, tdt_model_id, str(slice_path))
                    results.append(
                        {**seg, "text": text.strip() or "[No speech detected]"}
                    )

            await unload_model(t, tdt_model_id)

            # ── Step 3: Merge consecutive same-speaker segments and print ──

            print("\n▸ Diarized transcription")
            for entry in merge_speakers(results):
                print(
                    f"Speaker {entry['speaker']} "
                    f"({entry['start']:.2f}s - {entry['end']:.2f}s):"
                )
                print(f"  {entry['text']}\n")
            print("▸ Done")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
