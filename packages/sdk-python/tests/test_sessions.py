"""Unit tests for tetherto.qvac_sdk.sessions: the push-style duplex session model over a
fake transport -- event routing, done/error frame handling, single-use
iteration, write-after-close guards, and upstream delivery order."""

from __future__ import annotations

from typing import Any

import pytest

from tetherto.qvac_sdk.errors import (
    TextToSpeechStreamFailedError,
    TranscriptionFailedError,
)
from tetherto.qvac_sdk.sessions import (
    EndOfTurnEvent,
    SegmentEvent,
    TextEvent,
    VadEvent,
    bci_transcribe_stream_session,
    text_to_speech_stream_session,
    transcribe_stream_session,
)


class FakeDuplexTransport:
    """Consumes the whole upstream first (tests write+end before iterating),
    then yields the canned frames -- enough to exercise the session layer
    without a worker."""

    def __init__(self, frames: list[dict[str, Any]]):
        self.frames = frames
        self.sent: Any = None
        self.received: list[bytes] = []

    async def call(self, payload):
        raise NotImplementedError

    async def call_stream(self, payload):
        raise NotImplementedError
        yield

    async def call_duplex(self, payload, up):
        self.sent = payload
        async for chunk in up:
            self.received.append(chunk)
        for frame in self.frames:
            yield frame


def _t(text=None, done=None, error=None, segment=None, vad=None, end_of_turn=None):
    frame: dict[str, Any] = {"type": "transcribeStream"}
    if text is not None:
        frame["text"] = text
    if done is not None:
        frame["done"] = done
    if error is not None:
        frame["error"] = error
    if segment is not None:
        frame["segment"] = segment
    if vad is not None:
        frame["vad"] = vad
    if end_of_turn is not None:
        frame["endOfTurn"] = end_of_turn
    return frame


SEGMENT = {"text": "hi", "startMs": 0, "endMs": 500, "append": False, "id": 1}


# ---- transcribe sessions ---------------------------------------------------


async def test_text_session_yields_nonblank_text_and_stops_on_done():
    transport = FakeDuplexTransport(
        [_t(text="hello "), _t(text="   "), _t(text="world"), _t(done=True)]
    )
    session = transcribe_stream_session(transport, model_id="m-1")
    session.write(b"\x00\x01")
    session.end()
    texts = [event async for event in session]
    assert texts == ["hello ", "world"]
    assert transport.received == [b"\x00\x01"]
    assert transport.sent == {"type": "transcribeStream", "modelId": "m-1"}


async def test_metadata_session_yields_segments():
    transport = FakeDuplexTransport(
        [_t(text="ignored"), _t(segment=SEGMENT), _t(done=True)]
    )
    session = transcribe_stream_session(transport, model_id="m-1", metadata=True)
    session.end()
    segments = [event async for event in session]
    assert len(segments) == 1
    assert segments[0].text == "hi"
    assert transport.sent["metadata"] is True


async def test_conversation_session_routes_typed_events():
    transport = FakeDuplexTransport(
        [
            _t(vad={"speaking": True, "probability": 0.9}),
            _t(end_of_turn={"source": "whisper", "silenceDurationMs": 700}),
            _t(end_of_turn={"source": "parakeet"}),
            _t(text="hello"),
            _t(done=True),
        ]
    )
    session = transcribe_stream_session(transport, model_id="m-1", emit_vad_events=True)
    session.end()
    events = [event async for event in session]
    assert events == [
        VadEvent(speaking=True, probability=0.9),
        EndOfTurnEvent(source="whisper", silence_duration_ms=700),
        EndOfTurnEvent(source="parakeet", silence_duration_ms=None),
        TextEvent(text="hello"),
    ]
    assert transport.sent["emitVadEvents"] is True


async def test_conversation_session_with_metadata_yields_segment_events():
    transport = FakeDuplexTransport(
        [_t(segment=SEGMENT), _t(text="raw text ignored in metadata"), _t(done=True)]
    )
    session = transcribe_stream_session(
        transport, model_id="m-1", emit_vad_events=True, metadata=True
    )
    session.end()
    events = [event async for event in session]
    assert len(events) == 1
    assert isinstance(events[0], SegmentEvent)


async def test_frame_error_raises_typed_error():
    transport = FakeDuplexTransport([_t(text="ok"), _t(error="mic exploded")])
    session = transcribe_stream_session(transport, model_id="m-1")
    session.end()
    with pytest.raises(TranscriptionFailedError, match="mic exploded"):
        _ = [event async for event in session]


async def test_session_is_single_use():
    transport = FakeDuplexTransport([_t(done=True)])
    session = transcribe_stream_session(transport, model_id="m-1")
    session.end()
    _ = [event async for event in session]
    with pytest.raises(TranscriptionFailedError, match="iterated once"):
        _ = [event async for event in session]


async def test_write_after_end_raises():
    transport = FakeDuplexTransport([_t(done=True)])
    session = transcribe_stream_session(transport, model_id="m-1")
    session.end()
    with pytest.raises(TranscriptionFailedError, match="after end"):
        session.write(b"late")


async def test_aclose_tears_down_and_context_manager_works():
    transport = FakeDuplexTransport([_t(text="x"), _t(done=True)])
    async with transcribe_stream_session(transport, model_id="m-1") as session:
        session.end()
    with pytest.raises(TranscriptionFailedError, match="after end"):
        session.write(b"late")


# ---- BCI session -------------------------------------------------------------


async def test_bci_session_threads_request_id_and_stream_opts():
    transport = FakeDuplexTransport(
        [
            {"type": "bciTranscribeStream", "text": "decoded"},
            {"type": "bciTranscribeStream", "done": True},
        ]
    )
    session = bci_transcribe_stream_session(
        transport,
        model_id="m-1",
        window_timesteps=100,
        hop_timesteps=50,
        emit="delta",
    )
    session.write(b"\x00" * 8)
    session.end()
    texts = [event async for event in session]
    assert texts == ["decoded"]
    assert session.request_id
    assert transport.sent["requestId"] == session.request_id
    assert transport.sent["streamOpts"] == {
        "windowTimesteps": 100,
        "hopTimesteps": 50,
        "emit": "delta",
    }


# ---- TTS session -------------------------------------------------------------


def _tts_frame(buffer: list[float], done: bool = False, **extra) -> dict[str, Any]:
    return {"type": "textToSpeechStream", "buffer": buffer, "done": done, **extra}


async def test_tts_session_yields_frames_including_done_and_encodes_str_writes():
    transport = FakeDuplexTransport(
        [
            _tts_frame([0.1, 0.2], chunkIndex=0, sentenceChunk="Hello."),
            _tts_frame([0.3], done=True),
        ]
    )
    session = text_to_speech_stream_session(transport, model_id="m-1")
    session.write("Hello.")
    session.write(b" Bye.")
    session.end()
    frames = [frame async for frame in session]
    assert [frame.buffer for frame in frames] == [[0.1, 0.2], [0.3]]
    assert frames[0].sentence_chunk == "Hello."
    assert frames[-1].done is True
    assert transport.received == [b"Hello.", b" Bye."]
    assert transport.sent["inputType"] == "text"


async def test_tts_write_after_end_raises_tts_error():
    transport = FakeDuplexTransport([_tts_frame([], done=True)])
    session = text_to_speech_stream_session(transport, model_id="m-1")
    session.end()
    with pytest.raises(TextToSpeechStreamFailedError, match="after end"):
        session.write("late")
