"""Python port of packages/sdk/examples/tts/moss-dialogue.ts.

MOSS-TTSD (GGML): multi-speaker dialogue in one pass, each voice cloned from a
24 kHz reference recording. The model continues the references, so the text
opens with what each recording says under its speaker tag, followed by the
lines to generate; only the new lines come out as audio. A dialogue is never
split into sentences, so `stream: True` delivers the native chunks of the whole
conversation (set `streamChunkTokens` to get them while it is still being
generated).

The MOSS-TTSD backbone is not in the QVAC Registry yet, so it is a local file;
the codec halves it shares with MOSS-TTS download from the registry.

Python's `text_to_speech` yields frames: the example collects each frame's
`buffer` and reads `sample_rate` off them. The helpers below, ported from the
JS example's `utils`, save the samples to a WAV and play it through ffplay.

RUN: python examples/text_to_speech_moss_dialogue.py <moss-ttsd.gguf> <s1.wav> "<s1 transcript>" <s2.wav> "<s2 transcript>"
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
    TTS_CODEC_DECODER_MOSS_TTS_F16,
    TTS_CODEC_ENCODER_MOSS_TTS_F16,
)

# Only a fallback: the engine reports the rate it actually produced.
MOSS_SAMPLE_RATE = 24000


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
    if len(sys.argv) < 6 or not all(sys.argv[1:6]):
        print(
            "Usage: python examples/text_to_speech_moss_dialogue.py <moss-ttsd.gguf> "
            '<s1.wav> "<s1 transcript>" <s2.wav> "<s2 transcript>"',
            file=sys.stderr,
        )
        return 1
    backbone, s1_audio, s1_text, s2_audio, s2_text = sys.argv[1:6]

    async with Client() as client:
        t = client.transport
        try:
            model_id = await load_model(
                t,
                model_src=backbone,
                model_type="tts-ggml",
                model_config={
                    "ttsEngine": "moss",
                    "language": "en",
                    "mossCodecDecoderModelSrc": TTS_CODEC_DECODER_MOSS_TTS_F16,
                    "mossCodecEncoderModelSrc": TTS_CODEC_ENCODER_MOSS_TTS_F16,
                    # One recording per speaker, in the order the text tags them.
                    "dialogueReferenceSrcs": [s1_audio, s2_audio],
                    "streamChunkTokens": 25,
                    "useGPU": True,
                },
            )
            print(f"▸ Model loaded: {model_id}")

            print("▸ Synthesizing the dialogue...")
            request = TextToSpeechRequest.model_validate(
                {
                    "type": "textToSpeech",
                    "modelId": model_id,
                    "text": (
                        f"[S1] {s1_text} [S2] {s2_text} "
                        "[S1] Did the build finish? [S2] Yes, every test passed. "
                        "[S1] Great, ship it."
                    ),
                    "stream": True,
                }
            )

            samples: list[float] = []
            sample_rate = None
            async for response in text_to_speech(t, request):
                samples.extend(response.buffer)
                if response.sample_rate is not None:
                    sample_rate = response.sample_rate

            sample_rate = int(sample_rate or MOSS_SAMPLE_RATE)
            print(f"▸ Dialogue complete: {len(samples)} samples")

            create_wav(samples, sample_rate, "moss-dialogue-output.wav")
            print("▸ Audio saved to moss-dialogue-output.wav")

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
