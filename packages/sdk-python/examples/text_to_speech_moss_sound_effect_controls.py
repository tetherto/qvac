"""Python port of packages/sdk/examples/tts/moss-sound-effect-controls.ts.

Desktop MOSS-SoundEffect-v2, 48 kHz mono output. A GPU is recommended.
Optional: QVAC_MOSS_SFX_MODEL=/absolute/path/moss-sfx-v2-q8_0.gguf
Use the catalog source URL: its full descriptor selects the audiogen plugin.
Each clip denoises a 30-second latent, regardless of its requested output
duration. This example adds the generation controls: a `negativePrompt`, the
number of `steps`, the `guidance` scale and the scheduler `shift`.

Python's `text_to_speech` yields frames: the example collects each frame's
`buffer` and reads `sample_rate` and `done` off them. `Client` closes the SDK
on exit, which the TypeScript example does with `close()`.

RUN: python examples/text_to_speech_moss_sound_effect_controls.py
"""

from __future__ import annotations

import array
import asyncio
import contextlib
import math
import os
import sys
import wave

from tetherto.qvac_sdk import (
    Client,
    TextToSpeechRequest,
    load_model,
    text_to_speech,
    unload_model,
)
from tetherto.qvac_sdk.models import AUDIOGEN_MOSS_SFX_V2_Q8_0

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


async def main() -> int:
    async with Client() as client:
        t = client.transport
        model_id = None
        try:
            model_id = await load_model(
                t,
                model_src=os.environ.get("QVAC_MOSS_SFX_MODEL")
                or AUDIOGEN_MOSS_SFX_V2_Q8_0.src,
                model_type="tts-ggml",
                model_config={"ttsEngine": "moss-sfx", "useGPU": True, "seed": 42},
                on_progress=print_progress,
            )

            print("▸ Generating a sound effect...", file=sys.stderr)
            request = TextToSpeechRequest.model_validate(
                {
                    "type": "textToSpeech",
                    "modelId": model_id,
                    "text": "A dog barking twice in a quiet room.",
                    "stream": False,
                    "seconds": 3,
                    "negativePrompt": "Speech, music, background voices.",
                    "steps": 20,
                    "guidance": 4,
                    "shift": 5,
                }
            )

            samples: list[float] = []
            sample_rate = None
            done = False
            async for response in text_to_speech(t, request):
                samples.extend(response.buffer)
                if response.sample_rate is not None:
                    sample_rate = response.sample_rate
                done = done or response.done

            if not done:
                raise RuntimeError("Sound-effect generation did not complete.")
            if sample_rate != 48000:
                raise RuntimeError(
                    f"Unexpected sound-effect sample rate: {sample_rate}"
                )
            save_wav(samples, sample_rate, "moss-sound-effect-controls-output.wav")
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
