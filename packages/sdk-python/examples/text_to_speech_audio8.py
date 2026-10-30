"""Python port of packages/sdk/examples/tts/audio8.ts.

Audio8 (GGML): DualAR LM + codec decoder, native 44.1 kHz output. The primary
`model_src` is the LM GGUF; the codec decoder loads via `model_config`. For
zero-shot voice cloning also pass `audio8CodecEncoderModelSrc` plus
`referenceAudioSrc`/`referenceText` (a recording and its exact transcript). On
macOS and iOS the decoder downloads with its Core ML bundle, which runs the
codec's synthesis stack; `stats.codec_on_coreml` reports whether it did.

`text_to_speech` is a server-stream; in non-stream mode it yields the full
audio as one frame. Samples come back as int16 PCM values. The helpers below,
ported from the JS example's `utils`, save them to a WAV and play it through
ffplay.

RUN: python examples/text_to_speech_audio8.py
"""

from __future__ import annotations

import asyncio
import struct
import subprocess
import sys

from tetherto.qvac_sdk import (
    Client,
    TextToSpeechRequest,
    load_model,
    text_to_speech,
    unload_model,
)
from tetherto.qvac_sdk.models import (
    TTS_CODEC_DECODER_AUDIO8_Q8_0,
    TTS_LM_MULTILINGUAL_AUDIO8_Q8_0,
)

# Only a fallback: the engine reports the rate it actually produced.
AUDIO8_SAMPLE_RATE = 44100


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
    model_config = {
        "ttsEngine": "audio8",
        "audio8CodecDecoderModelSrc": TTS_CODEC_DECODER_AUDIO8_Q8_0,
        "temperature": 0.7,
        "topP": 0.9,
        "seed": 42,
    }

    async with Client() as client:
        t = client.transport
        try:
            model_id = await load_model(
                t,
                model_src=TTS_LM_MULTILINGUAL_AUDIO8_Q8_0,
                model_config=model_config,
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")

            print("▸ Testing Audio8 Text-to-Speech...")
            request = TextToSpeechRequest.model_validate(
                {
                    "type": "textToSpeech",
                    "modelId": model_id,
                    "text": "Hey, how are you doing today?",
                    "inputType": "text",
                    "stream": False,
                }
            )

            samples: list[float] = []
            sample_rate = None
            stats = None
            async for response in text_to_speech(t, request):
                samples.extend(response.buffer)
                if response.sample_rate is not None:
                    sample_rate = response.sample_rate
                if response.stats is not None:
                    stats = response.stats
            sample_rate = int(sample_rate or AUDIO8_SAMPLE_RATE)
            print(f"▸ TTS complete. Total samples: {len(samples)}")
            codec = "Core ML" if stats and stats.codec_on_coreml == 1 else "ggml"
            print(f"▸ Codec ran on {codec}")

            print("▸ Saving audio to file...")
            create_wav(samples, sample_rate, "audio8-output.wav")
            print("▸ Audio saved to audio8-output.wav")

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
