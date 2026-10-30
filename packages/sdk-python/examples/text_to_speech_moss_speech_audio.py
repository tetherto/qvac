"""Python port of packages/sdk/examples/tts/moss-speech-audio.ts.

Desktop MOSS-Speech: 9B language model + codec, 24 kHz spoken reply and text.
Pass a spoken question as a WAV file. Use a GPU with enough memory. Registry
sources download automatically. Optional local paths: QVAC_MOSS_SPEECH_MODEL
and QVAC_MOSS_SPEECH_CODEC. Both engines run a batch job; `stream: False`
collects the complete reply.

The question is read with `struct` instead of the stdlib `wave` module because
`wave` rejects float32 WAVs, which the TypeScript example accepts. Python's
`text_to_speech` yields frames: the example joins each frame's `text` and
`buffer` and reads `sample_rate` and `done` off them. `Client` closes the SDK
on exit, which the TypeScript example does with `close()`.

RUN: python examples/text_to_speech_moss_speech_audio.py <question.wav>
"""

from __future__ import annotations

import array
import asyncio
import contextlib
import math
import os
import struct
import sys
import wave
from pathlib import Path

from tetherto.qvac_sdk import (
    Client,
    TextToSpeechRequest,
    load_model,
    text_to_speech,
    unload_model,
)
from tetherto.qvac_sdk.models import TTS_CODEC_MOSS_SPEECH_F16, TTS_MOSS_SPEECH_Q8_0

_last_percentage = -1


def print_progress(p) -> None:
    """Print model download progress once per whole percent."""
    global _last_percentage
    percentage = math.floor(p.percentage)
    if percentage == _last_percentage:
        return
    _last_percentage = percentage
    line = (
        f"▸ Downloading {p.percentage:.0f}% "
        f"({p.downloaded / 1e6:.1f}/{p.total / 1e6:.1f} MB)"
    )
    print(line, end="\r" if sys.stderr.isatty() else "\n", file=sys.stderr)
    if p.percentage >= 100:
        print(file=sys.stderr)


def save_wav(samples, sample_rate, path) -> None:
    if not samples or not all(math.isfinite(s) for s in samples):
        raise RuntimeError("The model returned no usable audio.")
    pcm = array.array("h", (max(-32768, min(32767, round(s))) for s in samples))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    print(
        f"▸ Saved {path}: {sample_rate} Hz, {len(samples) / sample_rate:.2f} seconds",
        file=sys.stderr,
    )


def read_question(path: str) -> tuple[list[float], int]:
    """Read a mono/stereo PCM16 or float32 WAV as mono float samples."""
    wav = Path(path).read_bytes()
    if len(wav) < 12 or wav[0:4] != b"RIFF" or wav[8:12] != b"WAVE":
        raise ValueError("Question must be a RIFF WAV file.")

    fmt = channels = sample_rate = bits = 0
    data = None
    offset = 12
    while offset + 8 <= len(wav):
        chunk_id = wav[offset : offset + 4]
        (size,) = struct.unpack_from("<I", wav, offset + 4)
        start = offset + 8
        if start + size > len(wav):
            raise ValueError("Truncated WAV chunk.")
        if chunk_id == b"fmt ":
            if size < 16:
                raise ValueError("Invalid WAV format chunk.")
            fmt, channels, sample_rate = struct.unpack_from("<HHI", wav, start)
            (bits,) = struct.unpack_from("<H", wav, start + 14)
        elif chunk_id == b"data":
            data = wav[start : start + size]
        offset = start + size + (size % 2)

    if (
        data is None
        or channels not in (1, 2)
        or not ((fmt == 1 and bits == 16) or (fmt == 3 and bits == 32))
    ):
        raise ValueError("Use a mono/stereo PCM16 or float32 WAV question.")
    if not 8000 <= sample_rate <= 192000:
        raise ValueError("WAV sample rate must be 8000–192000 Hz.")
    frame_bytes = bits // 8 * channels
    if len(data) % frame_bytes != 0:
        raise ValueError("Incomplete WAV audio frame.")

    # array reads native byte order; WAV samples are little-endian.
    if sys.byteorder != "little":
        raise ValueError("This example reads WAV samples on little-endian hosts only.")
    if fmt == 1:
        values = [v / 32768 for v in array.array("h", data)]
    else:
        values = list(array.array("f", data))
    audio = [
        sum(values[i : i + channels]) / channels
        for i in range(0, len(values), channels)
    ]
    if not audio or len(audio) > sample_rate * 60:
        raise ValueError("Use a non-empty question of at most 60 seconds.")
    return audio, sample_rate


async def main() -> int:
    if len(sys.argv) < 2:
        print(
            "Usage: python examples/text_to_speech_moss_speech_audio.py <question.wav>",
            file=sys.stderr,
        )
        return 1

    try:
        audio, question_rate = read_question(sys.argv[1])
    except (OSError, ValueError) as error:
        print(f"✖ {error}", file=sys.stderr)
        return 1

    async with Client() as client:
        t = client.transport
        model_id = None
        try:
            model_id = await load_model(
                t,
                model_src=os.environ.get("QVAC_MOSS_SPEECH_MODEL")
                or TTS_MOSS_SPEECH_Q8_0,
                model_type="tts-ggml",
                model_config={
                    "ttsEngine": "moss-speech",
                    "mossSpeechCodecModelSrc": os.environ.get("QVAC_MOSS_SPEECH_CODEC")
                    or TTS_CODEC_MOSS_SPEECH_F16,
                    "useGPU": True,
                    "seed": 42,
                },
                on_progress=print_progress,
            )

            print("▸ Generating a spoken reply...", file=sys.stderr)
            request = TextToSpeechRequest.model_validate(
                {
                    "type": "textToSpeech",
                    "modelId": model_id,
                    "audio": audio,
                    "sampleRate": question_rate,
                    "stream": False,
                    "greedy": True,
                    "maxNewTokens": 128,
                    "maxReplySeconds": 5,
                    "messages": [
                        {
                            "role": "user",
                            "text": "Please answer the next spoken turn briefly.",
                        }
                    ],
                }
            )

            samples: list[float] = []
            reply = ""
            sample_rate = None
            done = False
            async for response in text_to_speech(t, request):
                samples.extend(response.buffer)
                if response.text:
                    reply += response.text
                if response.sample_rate is not None:
                    sample_rate = response.sample_rate
                done = done or response.done

            if not done:
                raise RuntimeError("Speech generation did not complete.")
            if reply.strip():
                print(reply)
            else:
                print("▸ The model returned an audio-only reply.", file=sys.stderr)
            if sample_rate != 24000:
                raise RuntimeError(f"Unexpected reply sample rate: {sample_rate}")
            save_wav(samples, sample_rate, "moss-speech-audio-output.wav")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
        finally:
            if model_id is not None:
                with contextlib.suppress(Exception):
                    await unload_model(t, model_id)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
