"""Python port of packages/sdk/examples/tts/moss.ts.

MOSS (GGML): OpenMOSS MOSS-TTS v1.5 Delay, an 8B backbone (about 17 GB) plus a
codec, so desktop only. The primary `model_src` is the backbone; the codec
decoder loads via `model_config`, and the codec encoder is only needed to clone
a voice from a 24 kHz reference recording (no transcript needed).

MOSS streams natively: with `streamChunkTokens` set, `stream: True` emits a
chunk every that-many codec frames (12.5 per second) while the backbone is
still generating, and the text is synthesized as one utterance, so the
`[pause 1.0s]` marker below and `durationTokens` apply to all of it.

TypeScript reads the stream from `bufferStream` and the rate and stats from
separate promises. Python's `text_to_speech` yields frames: the example
collects each frame's `buffer` and reads `sample_rate` and `stats` off them.
The helpers below, ported from the JS example's `utils`, save the samples to a
WAV and play it through ffplay.

RUN: python examples/text_to_speech_moss.py [reference-audio.wav]
"""

from __future__ import annotations

import asyncio
import struct
import subprocess
import sys
import time

from tetherto.qvac_sdk import (
    Client,
    TextToSpeechRequest,
    load_model,
    text_to_speech,
    unload_model,
)
from tetherto.qvac_sdk.models import (
    TTS_CODEC_DECODER_MOSS_TTS_F16,
    TTS_CODEC_ENCODER_MOSS_TTS_F16,
    TTS_DELAY_LLM_MOSS_TTS_F16,
)

# Only a fallback: the engine reports the rate it actually produced.
MOSS_SAMPLE_RATE = 24000


def print_progress(p) -> None:
    """Print model download progress; pass as `on_progress=` to `load_model`."""
    line = (
        f"▸ Downloading {p.percentage:.0f}% "
        f"({p.downloaded / 1e6:.1f}/{p.total / 1e6:.1f} MB)"
    )
    print(line, end="\r" if sys.stderr.isatty() else "\n", file=sys.stderr)
    if p.percentage >= 100:
        print(file=sys.stderr)


def create_wav_header(data_length: int, sample_rate: int) -> bytes:
    """Create a WAV header for 16-bit mono PCM audio."""
    return (
        b"RIFF"
        + struct.pack("<I", 36 + data_length)
        + b"WAVE"
        + b"fmt "
        + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
        + b"data"
        + struct.pack("<I", data_length)
    )


def int16_array_to_buffer(samples) -> bytes:
    """Convert int16 PCM samples to little-endian bytes."""
    return struct.pack(
        f"<{len(samples)}h",
        *(max(-32768, min(32767, round(s))) for s in samples),
    )


def create_wav(audio_buffer, sample_rate: int, filename: str) -> None:
    """Create and save a WAV file."""
    audio_data = int16_array_to_buffer(audio_buffer)
    with open(filename, "wb") as f:
        f.write(create_wav_header(len(audio_data), sample_rate) + audio_data)
    print(f"▸ WAV file saved as: {filename}")


def play_audio(audio_buffer: bytes) -> None:
    """Play a WAV buffer by streaming it into ffplay over stdin."""
    try:
        result = subprocess.run(
            [
                "ffplay",
                "-hide_banner",
                "-loglevel",
                "error",
                "-autoexit",
                "-nodisp",
                "-i",
                "pipe:0",
            ],
            input=audio_buffer,
            check=False,
        )
    except FileNotFoundError:
        raise RuntimeError(
            "ffplay not found on PATH. Install ffmpeg (ffplay ships with it) and retry."
        ) from None
    if result.returncode != 0:
        raise RuntimeError(f"ffplay exited with code {result.returncode}")


async def main() -> int:
    reference_audio_src = sys.argv[1] if len(sys.argv) > 1 else None

    model_config = {
        "ttsEngine": "moss",
        "language": "en",
        "mossCodecDecoderModelSrc": TTS_CODEC_DECODER_MOSS_TTS_F16,
        "streamChunkTokens": 25,
        "useGPU": True,
        "seed": 7,
    }
    if reference_audio_src:
        model_config["mossCodecEncoderModelSrc"] = TTS_CODEC_ENCODER_MOSS_TTS_F16
        model_config["referenceAudioSrc"] = reference_audio_src

    async with Client() as client:
        t = client.transport
        try:
            model_id = await load_model(
                t,
                model_src=TTS_DELAY_LLM_MOSS_TTS_F16,
                model_config=model_config,
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")

            print("▸ Streaming MOSS Text-to-Speech...")
            started = time.monotonic()
            request = TextToSpeechRequest.model_validate(
                {
                    "type": "textToSpeech",
                    "modelId": model_id,
                    "text": (
                        "Hold on [pause 1.0s] here it comes: speech that starts "
                        "playing while the rest is still being generated."
                    ),
                    "stream": True,
                }
            )

            samples: list[float] = []
            sample_rate = None
            stats = None
            async for response in text_to_speech(t, request):
                if response.buffer and not samples:
                    elapsed_ms = (time.monotonic() - started) * 1000
                    print(f"▸ First audio after {elapsed_ms:.0f} ms")
                samples.extend(response.buffer)
                if response.sample_rate is not None:
                    sample_rate = response.sample_rate
                if response.stats is not None:
                    stats = response.stats

            sample_rate = int(sample_rate or MOSS_SAMPLE_RATE)
            frames = "?"
            rtf = "?"
            if stats is not None:
                if stats.generated_frames is not None:
                    frames = f"{stats.generated_frames:g}"
                if stats.real_time_factor is not None:
                    rtf = f"{stats.real_time_factor:.2f}"
            print(
                f"▸ TTS complete: {len(samples)} samples, {frames} codec frames, "
                f"RTF {rtf}"
            )

            create_wav(samples, sample_rate, "moss-output.wav")
            print("▸ Audio saved to moss-output.wav")

            print("▸ Playing audio...")
            audio_data = int16_array_to_buffer(samples)
            play_audio(create_wav_header(len(audio_data), sample_rate) + audio_data)

            await unload_model(t, model_id)
            print("▸ Model unloaded")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
