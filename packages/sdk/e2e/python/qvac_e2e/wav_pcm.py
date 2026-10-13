"""WAV fixtures to PCM, kept in step with `tests/shared/wav-pcm.ts`."""

from __future__ import annotations

import io
import math
import sys
import wave
from array import array
from dataclasses import dataclass


@dataclass(frozen=True)
class DecodedPcm:
    sample_rate: int
    num_channels: int
    samples_mono: array  # 'f'


def decode_wav_to_mono_f32(data: bytes) -> DecodedPcm:
    """16-bit PCM WAV -> mono float32 in [-1, 1]."""
    try:
        with wave.open(io.BytesIO(data)) as reader:
            if reader.getsampwidth() != 2:
                raise ValueError(
                    "decode_wav_to_mono_f32: only 16-bit PCM is supported, got "
                    f"{reader.getsampwidth() * 8}-bit"
                )
            sample_rate = reader.getframerate()
            num_channels = reader.getnchannels()
            frames = reader.readframes(reader.getnframes())
    except (wave.Error, EOFError) as error:
        reason = str(error) or "not a RIFF/WAVE file"
        raise ValueError(f"decode_wav_to_mono_f32: {reason}") from error

    interleaved = array("h")
    interleaved.frombytes(frames)
    if sys.byteorder != "little":
        interleaved.byteswap()

    mono = array("f")
    for frame in range(len(interleaved) // num_channels):
        base = frame * num_channels
        total = sum(interleaved[base + c] for c in range(num_channels))
        mono.append(total / num_channels / 32768.0)

    return DecodedPcm(
        sample_rate=sample_rate, num_channels=num_channels, samples_mono=mono
    )


def f32_to_le_bytes(samples: array) -> bytes:
    """Raw little-endian float32, the form the whisper stream takes."""
    out = array("f", samples)
    if sys.byteorder != "little":
        out.byteswap()
    return out.tobytes()


def f32_to_s16_le_bytes(samples: array) -> bytes:
    """Signed 16-bit little-endian PCM, the form the parakeet stream takes."""
    out = array("h", (_to_s16(sample) for sample in samples))
    if sys.byteorder != "little":
        out.byteswap()
    return out.tobytes()


def _to_s16(sample: float) -> int:
    clamped = max(-1.0, min(1.0, sample))
    # `floor(x + 0.5)`, which is what JS's Math.round does: it rounds a half toward
    # +Infinity, where Python's round() goes to the nearest even and int() truncates
    # toward zero.
    return math.floor(clamped * 32767 + 0.5)
