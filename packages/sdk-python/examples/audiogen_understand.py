"""Python port of packages/sdk/examples/audiogen/understand-music.ts.

Describe an existing recording with ACE-Step's reverse pipeline: the engine
encodes the audio, recovers its FSQ semantic codes, and the LM reports a
caption and the clip's musical metadata.

Three things differ from TypeScript:

  - `audio_understand` is an async iterator despite the name carrying no
    `_stream` suffix, and the description arrives in a response's `understand`
    field, where TypeScript's `audioUnderstand` resolves a `description`
    promise. Progress ticks and the terminal stats frame share that same
    iterator.
  - `source_audio` is a tagged union here -- `{"type": "filePath", "value":
    path}` -- where TypeScript takes the bare path string. Pass `{"type":
    "base64", "value": ...}` instead when the audio is already in memory as raw
    interleaved stereo 48 kHz Float32 LE PCM in [-1, 1].
  - `model_type` is the canonical `"audiogen-ggml"`. `"audiogen"`, which
    TypeScript uses, is an alias here and `load_model` warns before
    normalizing it.

The source is a file path: the SDK decodes it (any FFmpeg-decodable format) to
the 48 kHz stereo float PCM the engine expects.

RUN: python examples/audiogen_understand.py <source-audio> [language]
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import (
    Client,
    generate_client_request_id,
    load_model,
    unload_model,
)
from tetherto.qvac_sdk.methods import audio_understand
from tetherto.qvac_sdk.models import (
    AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0,
    AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
    AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0,
    AUDIOGEN_VAE_BF16,
)
from tetherto.qvac_sdk.schemas import AudioUnderstandRequest


def print_progress(p) -> None:
    """Print model download progress; pass as `on_progress=` to `load_model`."""
    line = (
        f"▸ Downloading {p.percentage:.0f}% "
        f"({p.downloaded / 1e6:.1f}/{p.total / 1e6:.1f} MB)"
    )
    print(line, end="\r" if sys.stderr.isatty() else "\n", file=sys.stderr)
    if p.percentage >= 100:
        print(file=sys.stderr)


async def main() -> int:
    source_path = sys.argv[1] if len(sys.argv) > 1 else None
    vocal_language = sys.argv[2] if len(sys.argv) > 2 else None

    if not source_path:
        print(
            "Usage: python examples/audiogen_understand.py <source-audio> [language]",
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
                    "ditModelSrc": AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M.src,
                    "vaeModelSrc": AUDIOGEN_VAE_BF16.src,
                    "useGPU": True,
                },
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")
            print(f"▸ Analysing {source_path}")

            request_id = generate_client_request_id()
            request = AudioUnderstandRequest.model_validate(
                {
                    "type": "audioUnderstand",
                    "modelId": model_id,
                    "requestId": request_id,
                    "sourceAudio": {"type": "filePath", "value": source_path},
                    # Forced into the result instead of the LM's guess; omit to
                    # let it decide.
                    **(
                        {"vocalLanguage": vocal_language}
                        if vocal_language is not None
                        else {}
                    ),
                    "seed": 11,
                }
            )
            print(f"▸ requestId: {request_id}")

            description = None
            stats = None

            async for response in audio_understand(transport, request):
                if response.progress is not None:
                    progress = response.progress
                    value = (
                        f"{progress.step}/{progress.total}"
                        if progress.total > 0
                        else f"{progress.step} (indeterminate)"
                    )
                    print(f"▸ {progress.stage}: {value}")
                if response.understand is not None:
                    description = response.understand
                if response.done:
                    stats = response.stats
                    if (
                        response.stop_reason is not None
                        and response.stop_reason.value == "cancelled"
                    ):
                        print("▸ Analysis cancelled", file=sys.stderr)
                        return 1
                    break

            if description is None:
                raise RuntimeError("AudioUnderstand stream ended without a description")

            print(f"▸ Caption: {description.caption}")
            print(
                f"▸ {description.bpm} BPM, {description.keyscale}, "
                f"{description.timesignature}"
            )
            print(f"▸ Vocal language: {description.vocal_language}")
            # The LM's duration is an estimate; the recovered codes fix the
            # true length.
            print(f"▸ Estimated duration: {description.duration:.1f} s")
            print(f"▸ Recovered {len(description.audio_codes)} semantic codes")
            if stats is not None:
                reported = stats.model_dump(by_alias=True)
                reported.pop("understand", None)
                print(f"▸ Stats: {reported}")

            # `audioCodes` feeds straight back into a generation to
            # re-synthesize the piece without re-running the LM:
            #   AudioGenStreamRequest.model_validate({
            #       "type": "audioGenStream",
            #       "modelId": model_id,
            #       "caption": description.caption,
            #       "audioCodes": [code.root for code in description.audio_codes],
            #   })
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
