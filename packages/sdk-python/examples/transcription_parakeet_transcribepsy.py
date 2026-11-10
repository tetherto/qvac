"""Python port of packages/sdk/examples/asr/parakeet-transcribepsy-filesystem.ts.

TranscribePsy transcription from an audio file.

TranscribePsy-250M-EU-sub is a 254M Parakeet-TDT distilled for Dutch,
English, French, German, Italian, Polish, Portuguese and Spanish; the engine
detects the language, so there is nothing to set. The default constant
(`PARAKEET_TRANSCRIBEPSY_250M_Q8_0`) runs on ggml everywhere. On macOS and
iOS, `--coreml` loads the Core ML distribution instead
(`PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0`): the SDK downloads its encoder and
decoder bundles with the GGUF, and both stages run on the Neural Engine.
Anywhere else that constant is refused at load time.

`--eu` loads the full 25-language TranscribePsy-250M-EU instead
(`PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0`): one GGUF with its CAFE language
adapters and gate embedded, ggml on every platform, no Core ML distribution.
`--language` picks its route: `en` for the English trunk, `other` for the
non-English adapters, or `auto` (the default) to let the gate decide from the
first seconds of the recording.

Long recordings are encoded in overlapping windows, so memory stays flat
however long the file is. Without `--window-sec` the engine uses the 60 s
windows with 25 % overlap the model recommends; an explicit window is sent as
encoder frames (12.5 per second) with a quarter of it as context, which is how
a phone with little memory can trade speed for a smaller footprint.

TypeScript's `transcribe()` returns the joined text and exposes `stats`
separately. Python calls the worker directly, so `transcribe` yields
`TranscribeResponse` frames: the example joins their `text` and reads `stats`
off the closing frame.

RUN: python examples/transcription_parakeet_transcribepsy.py <audio-file> [--eu [--language en|other|auto]] [--coreml] [--window-sec <seconds>]
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import (
    Client,
    TranscribeRequest,
    load_model,
    transcribe,
    unload_model,
)
from tetherto.qvac_sdk.models import (
    PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0,
    PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0,
    PARAKEET_TRANSCRIBEPSY_250M_Q8_0,
)

ENCODER_FRAMES_PER_SECOND = 12.5
RECOMMENDED_OVERLAP = 0.25
EU_LANGUAGES = ("en", "other", "auto")
USAGE = (
    "Usage: python examples/transcription_parakeet_transcribepsy.py <audio-file> "
    "[--eu [--language en|other|auto]] [--coreml] [--window-sec <seconds>]"
)


def print_progress(p) -> None:
    """Print model download progress; pass as `on_progress=` to `load_model`."""
    line = (
        f"▸ Downloading {p.percentage:.0f}% "
        f"({p.downloaded / 1e6:.1f}/{p.total / 1e6:.1f} MB)"
    )
    print(line, end="\r" if sys.stderr.isatty() else "\n", file=sys.stderr)
    if p.percentage >= 100:
        print(file=sys.stderr)


def fmt(value: float | None, digits: int) -> str:
    """Format an optional stat, as TypeScript's `?.toFixed(n) ?? '?'`."""
    return "?" if value is None else f"{value:.{digits}f}"


def parse_args(
    args: list[str],
) -> tuple[str, bool, bool, str | None, float | None] | None:
    value_flags = {"--window-sec", "--language"}
    audio_path = next(
        (
            arg
            for index, arg in enumerate(args)
            if not arg.startswith("--")
            and (index == 0 or args[index - 1] not in value_flags)
        ),
        None,
    )
    use_coreml = "--coreml" in args
    use_eu = "--eu" in args
    window_seconds = None
    if "--window-sec" in args:
        index = args.index("--window-sec")
        try:
            window_seconds = float(args[index + 1])
        except (IndexError, ValueError):
            return None
        if not window_seconds > 0:
            return None
    language = None
    if "--language" in args:
        index = args.index("--language")
        language = args[index + 1] if index + 1 < len(args) else None
        # The route only means something to the full EU model; EU-sub has no gate.
        if not use_eu or language not in EU_LANGUAGES:
            return None
    if audio_path is None or (use_eu and use_coreml):
        return None
    return audio_path, use_eu, use_coreml, language, window_seconds


async def main() -> int:
    parsed = parse_args(sys.argv[1:])
    if parsed is None:
        print(USAGE, file=sys.stderr)
        return 1
    audio_path, use_eu, use_coreml, language, window_seconds = parsed

    # An explicit window becomes the engine's frame counts; the overlap is
    # shared half and half with each neighbouring window.
    long_form = (
        {}
        if window_seconds is None
        else {
            "longFormWindowFrames": round(window_seconds * ENCODER_FRAMES_PER_SECOND),
            "longFormContextFrames": round(
                window_seconds * ENCODER_FRAMES_PER_SECOND * RECOMMENDED_OVERLAP / 2
            ),
        }
    )

    if use_eu:
        model_src = PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0
        variant = f"EU, 25 languages, route {language or 'auto'}"
    elif use_coreml:
        model_src = PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0
        variant = "EU-sub, Core ML distribution"
    else:
        model_src = PARAKEET_TRANSCRIBEPSY_250M_Q8_0
        variant = "EU-sub, ggml"
    route = {"language": language} if use_eu and language is not None else {}

    async with Client() as client:
        t = client.transport
        try:
            print(f"▸ Loading TranscribePsy ({variant})...")
            model_id = await load_model(
                t,
                model_src=model_src,
                model_type="parakeet-transcription",
                model_config={**long_form, **route},
                on_progress=print_progress,
            )

            print(
                "▸ Transcribing with the windows the model recommends (60 s, 25 % overlap)..."
                if window_seconds is None
                else f"▸ Transcribing in {window_seconds:g} s windows..."
            )
            # audioChunk is a typed chunk, not a bare path: JS's transcribe
            # wrapper turns a string into {type:"filePath"} for you, but Python
            # calls the generated stub directly, so build the chunk explicitly.
            request = TranscribeRequest.model_validate(
                {
                    "type": "transcribe",
                    "modelId": model_id,
                    "audioChunk": {"type": "filePath", "value": audio_path},
                }
            )

            text = ""
            stats = None
            async for response in transcribe(t, request):
                if response.text:
                    text += response.text
                if response.stats is not None:
                    stats = response.stats

            print(text)
            if stats is not None:
                summary = (
                    f"▸ {fmt(stats.audio_duration, 1)} s of audio, "
                    f"real-time factor {fmt(stats.real_time_factor, 3)}"
                )
                if use_coreml:
                    used = "yes" if stats.encoder_used_coreml == 1 else "no"
                    summary += f", encoder on Core ML: {used}"
                print(summary)

            await unload_model(t, model_id)
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
