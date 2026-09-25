"""Minimal WAV (RIFF) decoder, kept in step with `tests/shared/wav-pcm.ts`.

Supports canonical PCM WAV: format code 1, 16-bit signed, any channel count
and sample rate. Down-mixes to mono and converts to f32 in [-1, 1].

Written out rather than taken from the stdlib's `wave` module so the two
clients decode a fixture the same way: "the same audio went in" is a premise
every transcription comparison rests on, and two decoders that disagree about
down-mixing would make it false without anything reporting a failure.
"""

from __future__ import annotations

import math
import struct
import sys
from array import array
from dataclasses import dataclass


@dataclass(frozen=True)
class DecodedPcm:
    sample_rate: int
    num_channels: int
    samples_mono: array  # 'f'


def decode_wav_to_mono_f32(data: bytes) -> DecodedPcm:
    if len(data) < 12 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("decode_wav_to_mono_f32: not a RIFF/WAVE file")

    offset = 12
    audio_format = 0
    num_channels = 0
    sample_rate = 0
    bits_per_sample = 0
    fmt_found = False
    pcm: bytes | None = None

    while offset + 8 <= len(data):
        chunk_id = data[offset : offset + 4]
        (chunk_size,) = struct.unpack_from("<I", data, offset + 4)
        body = offset + 8

        if chunk_id == b"fmt ":
            audio_format, num_channels, sample_rate = struct.unpack_from(
                "<HHI", data, body
            )
            bits_per_sample = struct.unpack_from("<H", data, body + 14)[0]
            fmt_found = True
        elif chunk_id == b"data":
            pcm = data[body : body + chunk_size]

        # Chunks are word-aligned: an odd size carries a pad byte.
        offset = body + chunk_size + (chunk_size & 1)

    if not fmt_found:
        raise ValueError("decode_wav_to_mono_f32: no fmt chunk")
    if pcm is None:
        raise ValueError("decode_wav_to_mono_f32: no data chunk")
    if audio_format != 1 or bits_per_sample != 16:
        raise ValueError(
            "decode_wav_to_mono_f32: only 16-bit PCM is supported, got "
            f"format={audio_format} bits={bits_per_sample}"
        )
    if num_channels < 1:
        raise ValueError("decode_wav_to_mono_f32: no channels")

    interleaved = array("h")
    interleaved.frombytes(pcm[: len(pcm) - (len(pcm) % (2 * num_channels))])

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
    # `floor(x + 0.5)`, which is what JS's Math.round does: it rounds a half
    # toward +Infinity, where Python's round() goes to the nearest even and
    # int() truncates toward zero. On a fixture with exact halves the three
    # disagree, and the two clients would feed the engine different audio.
    return math.floor(clamped * 32767 + 0.5)
