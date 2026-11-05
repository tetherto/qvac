"""Python port of packages/sdk/examples/audiogen/generate-music.ts.

Generate music with ACE-Step AudioGen. Python exposes the contract-level
`audio_gen_stream` method, so this example decodes and joins its base64 PCM
chunks before writing a WAV file.

RUN:
  python examples/audiogen.py "lo-fi hip hop, mellow piano" audiogen-output.wav
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import sys
import wave

from tetherto.qvac_sdk import (
    Client,
    generate_client_request_id,
    load_model,
    unload_model,
)
from tetherto.qvac_sdk.methods import audio_gen_stream
from tetherto.qvac_sdk.models import (
    AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0,
    AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
    AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0,
    AUDIOGEN_VAE_BF16,
)
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


async def main() -> int:
    parser = argparse.ArgumentParser(description="Generate music with AudioGen")
    parser.add_argument(
        "caption",
        nargs="?",
        default="Lo-fi hip hop with mellow piano, soft drums, and warm bass",
    )
    parser.add_argument("output", nargs="?", default="audiogen-output.wav")
    args = parser.parse_args()

    async with Client() as client:
        transport = client.transport
        model_id: str | None = None

        try:
            print("▸ Loading ACE-Step AudioGen models...")
            model_id = await load_model(
                transport,
                model_type="audiogen-ggml",
                model_config={
                    "textEncModelSrc": AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0.src,
                    "lmModelSrc": AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0.src,
                    "ditModelSrc": AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M.src,
                    "vaeModelSrc": AUDIOGEN_VAE_BF16.src,
                    "useGPU": True,
                    "inferenceSteps": 8,
                },
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")

            request_id = generate_client_request_id()
            request = AudioGenStreamRequest(
                model_id=model_id,
                request_id=request_id,
                caption=args.caption,
                lyrics="[Instrumental]",
                seed=42,
                duration=10,
            )

            print(f"▸ requestId: {request_id}")
            print(f"▸ Generating: {args.caption}")

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

            pcm = b"".join(pcm_chunks)
            write_wav(pcm, sample_rate, channels, bits_per_sample, args.output)
            samples_per_channel = len(pcm) // (bits_per_sample // 8) // channels
            print(
                f"▸ Generated {samples_per_channel} samples per channel at "
                f"{sample_rate} Hz ({channels} channels)"
            )
            if stats is not None:
                print(f"▸ Stats: {stats.model_dump(by_alias=True)}")
            print(f"▸ Saved {args.output}")
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
