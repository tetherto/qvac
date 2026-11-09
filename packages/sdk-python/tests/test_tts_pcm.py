import array
import asyncio
import base64

import tetherto.qvac_sdk as sdk
from tetherto.qvac_sdk import TextToSpeechRequest, TextToSpeechStreamRequest, methods
from tetherto.qvac_sdk._streams import tts_samples
from tetherto.qvac_sdk.sessions import _tts_process


def _pcm(samples: list[int]) -> str:
    return base64.b64encode(array.array("h", samples).tobytes()).decode("ascii")


class _Frame:
    def __init__(self, buffer, pcm=None):
        self.buffer = buffer
        self.pcm = pcm


def test_tts_samples_decodes_int16_pcm():
    samples = [0, 1, -1, 32767, -32768, 12345]
    assert tts_samples(_Frame([], _pcm(samples))) == samples


def test_tts_samples_falls_back_to_buffer():
    assert tts_samples(_Frame([1, 2, 3])) == [1, 2, 3]
    assert tts_samples(_Frame([])) == []


def test_duplex_frames_are_decoded_before_they_reach_callers():
    frame = _tts_process(
        {
            "type": "textToSpeechStream",
            "buffer": [],
            "pcm": _pcm([7, -7]),
            "done": False,
        }
    )
    assert frame.buffer == [7, -7]
    assert frame.pcm is None
    plain = _tts_process({"type": "textToSpeechStream", "buffer": [1], "done": True})
    assert plain.buffer == [1]


class _FakeTransport:
    def __init__(self, frames):
        self.frames = frames

    async def call_stream(self, payload):
        for frame in self.frames:
            yield frame

    async def call_duplex(self, payload, up):
        for frame in self.frames:
            yield frame


async def _collect(iterator):
    return [frame async for frame in iterator]


def test_public_text_to_speech_decodes_pcm_frames():
    assert sdk.text_to_speech is methods.text_to_speech
    frames = [
        {
            "type": "textToSpeech",
            "buffer": [],
            "pcm": _pcm([1, -1, 32767]),
            "done": False,
        },
        {"type": "textToSpeech", "buffer": [9], "done": True},
    ]
    request = TextToSpeechRequest.model_validate(
        {"type": "textToSpeech", "modelId": "m", "inputType": "text", "text": "Hi."}
    )
    out = asyncio.run(_collect(sdk.text_to_speech(_FakeTransport(frames), request)))
    assert out[0].buffer == [1, -1, 32767]
    assert out[0].pcm is None
    assert out[1].buffer == [9]
    assert out[1].done is True


def test_public_text_to_speech_stream_decodes_pcm_frames():
    assert sdk.text_to_speech_stream is methods.text_to_speech_stream
    frames = [
        {
            "type": "textToSpeechStream",
            "buffer": [],
            "pcm": _pcm([7, -7]),
            "done": False,
        },
        {"type": "textToSpeechStream", "buffer": [], "done": True},
    ]
    request = TextToSpeechStreamRequest.model_validate(
        {"type": "textToSpeechStream", "modelId": "m", "inputType": "text"}
    )

    async def up():
        yield b"Hi."

    out = asyncio.run(
        _collect(sdk.text_to_speech_stream(_FakeTransport(frames), request, up()))
    )
    assert out[0].buffer == [7, -7]
    assert out[0].pcm is None
    assert out[1].done is True
