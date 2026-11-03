"""Python port of packages/sdk/examples/audiogen/generate-music-minimax.ts.

Generate music with the MiniMax-Music3 AudioGen engine. The SDK does not
download MiniMax-Music3 from the registry, so both GGUF files are yours to
bring: point AUDIOGEN_MINIMAX_LM_MODEL and AUDIOGEN_MINIMAX_SYNTH_MODEL at
them.

MiniMax exposes a smaller input surface than ACE-Step. It rejects the musical
controls (bpm, keyscale, timesignature, vocalLanguage), the LM and DCW knobs,
every reference/cover field, and both the edit and understand calls; it
ignores simpleMode and normalizeLoudness.

Two things differ from TypeScript:

  - The method is the contract-level `audio_gen_stream`, one async iterator,
    where TypeScript's `audioGen` hands back `progressStream`, `audio` and
    `stats` as separate channels. Progress ticks, base64 PCM chunks and the
    terminal stats frame all arrive on that one iterator, so this example
    decodes and joins the chunks itself.
  - `model_type` is the canonical `"audiogen-ggml"`. `"audiogen"`, which
    TypeScript uses, is an alias here and `load_model` warns before
    normalizing it.

Environment:
  AUDIOGEN_MINIMAX_LM_MODEL     required, path to mm3-lm-*.gguf
  AUDIOGEN_MINIMAX_SYNTH_MODEL  required, path to mm3-synth-*.gguf
  AUDIOGEN_USE_GPU              "1" to run on a GPU when one is usable
  AUDIOGEN_THREADS              load-time CPU thread count
  AUDIOGEN_LYRICS               defaults to "[Instrumental]"
  AUDIOGEN_SEED                 defaults to 7
  AUDIOGEN_CFG_SCALE            defaults to 1.7
  AUDIOGEN_MAX_FRAMES           semantic-frame cap, 25 per second
  AUDIOGEN_STEPS                flow sampling steps

RUN: AUDIOGEN_MINIMAX_LM_MODEL=... AUDIOGEN_MINIMAX_SYNTH_MODEL=... python examples/audiogen_minimax.py [caption] [output.wav]
"""

from __future__ import annotations

import asyncio
import base64
import os
import sys
import wave

from tetherto.qvac_sdk import (
    Client,
    generate_client_request_id,
    load_model,
    unload_model,
)
from tetherto.qvac_sdk.methods import audio_gen_stream
from tetherto.qvac_sdk.schemas import AudioGenStreamRequest


def print_progress(p) -> None:
    """Print model download progress; pass as `on_progress=` to `load_model`."""
    line = (
        f"▸ Downloading {p.percentage:.0f}% "
        f"({p.downloaded / 1e6:.1f}/{p.total / 1e6:.1f} MB)"
    )
    print(line, end="\r" if sys.stderr.isatty() else "\n", file=sys.stderr)
    if p.percentage >= 100:
        print(file=sys.stderr)


def write_wav(
    pcm: bytes, sample_rate: int, channels: int, bits_per_sample: int, path: str
) -> None:
    with wave.open(path, "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(bits_per_sample // 8)
        output.setframerate(sample_rate)
        output.writeframes(pcm)


def required_model_path(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def number_from_env(name: str) -> float | None:
    value = os.environ.get(name)
    if value is None:
        return None
    if value.strip() == "":
        raise RuntimeError(f"{name} must not be empty")
    try:
        return float(value)
    except ValueError as error:
        raise RuntimeError(f"{name} must be a finite number") from error


async def main() -> int:
    caption = (
        sys.argv[1] if len(sys.argv) > 1 else "Warm cinematic piano with gentle strings"
    )
    output_path = sys.argv[2] if len(sys.argv) > 2 else "minimax-music3-output.wav"

    async with Client() as client:
        transport = client.transport
        model_id: str | None = None

        try:
            threads = number_from_env("AUDIOGEN_THREADS")
            max_frames = number_from_env("AUDIOGEN_MAX_FRAMES")
            inference_steps = number_from_env("AUDIOGEN_STEPS")
            seed = number_from_env("AUDIOGEN_SEED")
            cfg_scale = number_from_env("AUDIOGEN_CFG_SCALE")

            print("▸ Loading MiniMax-Music3 models...")
            model_id = await load_model(
                transport,
                model_type="audiogen-ggml",
                model_config={
                    "engine": "minimax",
                    "lmModelSrc": required_model_path("AUDIOGEN_MINIMAX_LM_MODEL"),
                    "synthModelSrc": required_model_path(
                        "AUDIOGEN_MINIMAX_SYNTH_MODEL"
                    ),
                    "useGPU": os.environ.get("AUDIOGEN_USE_GPU") == "1",
                    **({"threads": int(threads)} if threads is not None else {}),
                },
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")
            print(f"▸ Generating: {caption}")

            request_id = generate_client_request_id()
            request = AudioGenStreamRequest.model_validate(
                {
                    "type": "audioGenStream",
                    "modelId": model_id,
                    "requestId": request_id,
                    "caption": caption,
                    "lyrics": os.environ.get("AUDIOGEN_LYRICS", "[Instrumental]"),
                    "seed": int(seed) if seed is not None else 7,
                    "cfgScale": cfg_scale if cfg_scale is not None else 1.7,
                    # maxFrames and duration are mutually exclusive; this
                    # example takes the explicit frame cap when one is set.
                    **(
                        {"maxFrames": int(max_frames)} if max_frames is not None else {}
                    ),
                    **(
                        {"inferenceSteps": int(inference_steps)}
                        if inference_steps is not None
                        else {}
                    ),
                }
            )
            print(f"▸ requestId: {request_id}")

            pcm_chunks: list[bytes] = []
            sample_rate: int | None = None
            channels: int | None = None
            bits_per_sample: int | None = None
            stats = None

            async for response in audio_gen_stream(transport, request):
                if response.progress is not None:
                    progress = response.progress
                    value = (
                        f"{progress.step}/{progress.total}"
                        if progress.total > 0
                        else f"{progress.step} (indeterminate)"
                    )
                    print(f"▸ {progress.stage}: {value}")
                if response.data is not None:
                    pcm_chunks.append(base64.b64decode(response.data))
                    sample_rate = response.sample_rate
                    channels = response.channels
                    bits_per_sample = response.bits_per_sample
                if response.done:
                    stats = response.stats
                    if (
                        response.stop_reason is not None
                        and response.stop_reason.value == "cancelled"
                    ):
                        print("▸ Generation cancelled", file=sys.stderr)
                        return 1
                    break

            if (
                sample_rate is None
                or channels is None
                or bits_per_sample is None
                or bits_per_sample % 8 != 0
                or not pcm_chunks
            ):
                raise RuntimeError("AudioGen stream ended without audio data")

            write_wav(
                b"".join(pcm_chunks),
                sample_rate,
                channels,
                bits_per_sample,
                output_path,
            )
            if stats is not None:
                print(f"▸ Stats: {stats.model_dump(by_alias=True)}")
            print(f"▸ Saved {output_path}")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
        finally:
            if model_id is not None:
                try:
                    await unload_model(transport, model_id)
                    print("▸ Model unloaded")
                except Exception as unload_error:
                    print(f"✖ Failed to unload model: {unload_error}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
