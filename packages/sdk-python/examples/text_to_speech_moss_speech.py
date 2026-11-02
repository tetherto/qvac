"""Python port of packages/sdk/examples/tts/moss-speech.ts.

Desktop MOSS-Speech: answer a typed question with `textReply: True`. This mode
skips audio decoding and returns text with an empty PCM buffer. Use a GPU with
enough memory. Registry sources download automatically. Optional local paths:
QVAC_MOSS_SPEECH_MODEL and QVAC_MOSS_SPEECH_CODEC. Both engines run a batch
job; `stream: False` collects the complete reply.

Python's `text_to_speech` yields frames: the example joins each frame's `text`
and `buffer` and reads `done` off them. `Client` closes the SDK on exit, which
the TypeScript example does with `close()`.

RUN: python examples/text_to_speech_moss_speech.py
"""

from __future__ import annotations

import asyncio
import contextlib
import math
import os
import sys

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


async def main() -> int:
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

            print("▸ Generating a text-only reply...", file=sys.stderr)
            request = TextToSpeechRequest.model_validate(
                {
                    "type": "textToSpeech",
                    "modelId": model_id,
                    "text": "What is two plus two? Answer in one short sentence.",
                    "stream": False,
                    "textReply": True,
                    "greedy": True,
                    "maxNewTokens": 128,
                    "maxReplySeconds": 5,
                    "systemPrompt": (
                        "You are a helpful assistant. Give short, direct answers."
                    ),
                }
            )

            samples: list[float] = []
            reply = ""
            done = False
            async for response in text_to_speech(t, request):
                samples.extend(response.buffer)
                if response.text:
                    reply += response.text
                done = done or response.done

            if not done or not reply.strip():
                raise RuntimeError("The model returned no reply text.")
            print(reply)
            if samples:
                raise RuntimeError("A text-only reply must not contain PCM audio.")
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
