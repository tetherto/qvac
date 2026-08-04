"""Python port of packages/sdk/examples/tts/supertonic.ts.

Text-to-speech with Supertonic 3 (GGML). `text_to_speech` is a server-stream;
in non-stream mode it yields the full audio as one frame. Samples come back as
int16 PCM values, written here to a WAV with the stdlib `wave` module (the JS
example's `createWav`/`playAudio` helpers).

RUN: python examples/text_to_speech.py
"""

from __future__ import annotations

import array
import asyncio
import sys
import wave

from _common import print_progress

from tetherto.qvac_sdk import (
    Client,
    TextToSpeechRequest,
    load_model,
    text_to_speech,
    unload_model,
)
from tetherto.qvac_sdk.models import TTS_MULTILINGUAL_SUPERTONIC3_Q8_0

SUPERTONIC_SAMPLE_RATE = 44100


def write_wav(samples, sample_rate, path) -> None:
    pcm = array.array("h", (max(-32768, min(32767, int(s))) for s in samples))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())


async def main() -> int:
    async with Client() as client:
        t = client.transport
        try:
            model_id = await load_model(
                t,
                model_src=TTS_MULTILINGUAL_SUPERTONIC3_Q8_0,
                model_config={
                    "ttsEngine": "supertonic",
                    "language": "en",
                    "voice": "F1",
                    "ttsSpeed": 1.05,
                    "ttsNumInferenceSteps": 5,
                },
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")

            print("▸ Testing Text-to-Speech...")
            request = TextToSpeechRequest.model_validate(
                {
                    "type": "textToSpeech",
                    "modelId": model_id,
                    "text": (
                        "QVAC SDK is the canonical entry point to QVAC. It provides all "
                        "QVAC capabilities through a unified interface."
                    ),
                    "inputType": "text",
                    "stream": False,
                }
            )

            samples: list[float] = []
            async for response in text_to_speech(t, request):
                samples.extend(response.buffer)
            print(f"▸ TTS complete. Total samples: {len(samples)}")

            out = "supertonic-output.wav"
            write_wav(samples, SUPERTONIC_SAMPLE_RATE, out)
            print(f"▸ Audio saved to {out}")

            await unload_model(t, model_id)
            print("▸ Model unloaded")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
