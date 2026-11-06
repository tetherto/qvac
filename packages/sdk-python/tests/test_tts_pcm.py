import array
import base64

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
