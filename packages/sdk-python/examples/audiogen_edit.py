"""Python port of packages/sdk/examples/audiogen/edit-music.ts.

Edit an existing recording with ACE-Step: a Flow-Edit that re-conditions the
whole clip from a source prompt to a target prompt, then a Repaint that
regenerates one time range against a new prompt. Operations run in order.

The source must run at least REPAINT_END seconds: the Repaint below asks for a
fixed window, and a range past the end of the source is rejected with
`repaint.start must be within the source duration`.

Three things differ from TypeScript:

  - The method is the contract-level `audio_edit_stream`, one async iterator,
    where TypeScript's `audioEdit` hands back `progressStream`, `audio` and
    `stats` as separate channels. Progress ticks, base64 PCM chunks and the
    terminal stats frame all arrive on that one iterator, so this example
    decodes and joins the chunks itself.
  - `source_audio` is a tagged union here -- `{"type": "filePath", "value":
    path}` -- where TypeScript takes the bare path string. Pass `{"type":
    "base64", "value": ...}` instead when the audio is already in memory as raw
    interleaved stereo 48 kHz Float32 LE PCM in [-1, 1], for example the `pcm`
    of an earlier generation converted from Int16 to Float32.
  - `model_type` is the canonical `"audiogen-ggml"`. `"audiogen"`, which
    TypeScript uses, is an alias here and `load_model` warns before
    normalizing it.

RUN: python examples/audiogen_edit.py <source-audio> [from-caption] [to-caption] [output.wav]
"""

from __future__ import annotations

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
from tetherto.qvac_sdk.methods import audio_edit_stream
from tetherto.qvac_sdk.models import (
    AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0,
    AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
    AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0,
    AUDIOGEN_VAE_BF16,
)
from tetherto.qvac_sdk.schemas import AudioEditStreamRequest

# Repaint window, in seconds from the start of the source.
REPAINT_START = 10
REPAINT_END = 20


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
    source_path = sys.argv[1] if len(sys.argv) > 1 else None
    from_caption = sys.argv[2] if len(sys.argv) > 2 else "Original pop song"
    to_caption = sys.argv[3] if len(sys.argv) > 3 else "Guitar pop-rock"
    output_path = sys.argv[4] if len(sys.argv) > 4 else "audiogen-edit.wav"

    if not source_path:
        print(
            "Usage: python examples/audiogen_edit.py "
            "<source-audio> [from-caption] [to-caption] [output.wav]",
            file=sys.stderr,
        )
        return 1

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
                    # Flow-Edit needs a turbo DiT variant; Repaint works on
                    # every variant.
                    "ditModelSrc": AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M.src,
                    "vaeModelSrc": AUDIOGEN_VAE_BF16.src,
                    "useGPU": True,
                },
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")
            print(f'▸ Editing {source_path}: "{from_caption}" -> "{to_caption}"')

            request_id = generate_client_request_id()
            request = AudioEditStreamRequest.model_validate(
                {
                    "type": "audioEditStream",
                    "modelId": model_id,
                    "requestId": request_id,
                    "sourceAudio": {"type": "filePath", "value": source_path},
                    "operations": [
                        {
                            "type": "flow-edit",
                            "from": {"caption": from_caption},
                            "to": {"caption": to_caption},
                        },
                        {
                            # Regenerate the repaint window as a synth solo;
                            # the rest is kept.
                            "type": "repaint",
                            "caption": "analog synth solo",
                            "lyrics": "[Instrumental]",
                            "start": REPAINT_START,
                            "end": REPAINT_END,
                            "mode": "balanced",
                            "strength": 0.5,
                        },
                    ],
                    # Seeds the first operation; each following operation uses
                    # seed + its index.
                    "seed": 22883,
                }
            )
            print(f"▸ requestId: {request_id}")

            pcm_chunks: list[bytes] = []
            sample_rate: int | None = None
            channels: int | None = None
            bits_per_sample: int | None = None
            stats = None

            async for response in audio_edit_stream(transport, request):
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
                        print("▸ Edit cancelled", file=sys.stderr)
                        return 1
                    break

            if (
                sample_rate is None
                or channels is None
                or bits_per_sample is None
                or bits_per_sample % 8 != 0
                or not pcm_chunks
            ):
                raise RuntimeError("AudioEdit stream ended without audio data")

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
