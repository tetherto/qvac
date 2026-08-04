"""Duplex streaming session model: push-style write/end/close ergonomics
over the pull-based `Transport.call_duplex`.

Ports the JS SDK's bidirectional session objects (`client/api/transcribe.ts`,
`bci-transcribe.ts`, `text-to-speech.ts`): the caller `write()`s upstream
chunks and iterates typed downstream events, instead of pre-building a whole
`AsyncIterable[bytes]` for the raw generated stubs. The transport already
splits newline-delimited frames into dicts and raises reconstructed typed
errors for in-band `{"type": "error"}` envelopes, so the per-frame work here
is validation, per-frame `error` fields, `done` termination, and event
routing (VAD / end-of-turn / segment / text).

Sessions are single-use: a second iteration attempt raises, matching JS.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any, Generic, TypeVar

from ._transport import Transport
from .errors import QvacError, TextToSpeechStreamFailedError, TranscriptionFailedError
from .schemas import (
    BciTranscribeStreamRequest,
    BciTranscribeStreamResponse,
    TextToSpeechStreamRequest,
    TextToSpeechStreamResponse,
    TranscribeStreamRequest,
    TranscribeStreamResponse,
)

T = TypeVar("T")

# Sentinels for the per-frame processor: _SKIP drops the frame, _DONE ends
# iteration without yielding (the JS null/undefined contract).
_SKIP = object()
_DONE = object()


# ---- Conversation events (transcribe with emitVadEvents / parakeet) ------


@dataclass(frozen=True)
class VadEvent:
    speaking: bool
    probability: float
    type: str = "vad"


@dataclass(frozen=True)
class EndOfTurnEvent:
    source: str
    silence_duration_ms: float | None = None
    type: str = "endOfTurn"


@dataclass(frozen=True)
class TextEvent:
    text: str
    type: str = "text"


@dataclass(frozen=True)
class SegmentEvent:
    segment: Any
    type: str = "segment"


TranscribeStreamEvent = VadEvent | EndOfTurnEvent | TextEvent | SegmentEvent


# ---- Upstream push -> pull adapter ----------------------------------------


class _UpstreamWriter:
    """Bridges the session's push-style write()/end() to the AsyncIterable
    the transport pulls from. Unbounded queue, matching the JS sessions'
    unmetered `requestStream.write` usage."""

    def __init__(self) -> None:
        self._queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        self.closed = False

    def write(self, chunk: bytes) -> None:
        self._queue.put_nowait(chunk)

    def end(self) -> None:
        if not self.closed:
            self.closed = True
            self._queue.put_nowait(None)

    async def stream(self) -> AsyncIterator[bytes]:
        while True:
            chunk = await self._queue.get()
            if chunk is None:
                return
            yield chunk


# ---- Session ---------------------------------------------------------------


class DuplexSession(Generic[T]):
    """One bidirectional stream: `write()` upstream bytes, `end()` to signal
    end of input, iterate for downstream events, `aclose()` (or `async
    with`) to tear down early. `request_id` is set when the wire request
    carries one (BCI), for `cancel(request_id=...)` targeting."""

    def __init__(
        self,
        transport: Transport,
        wire: dict[str, Any],
        process: Callable[[dict[str, Any]], Any],
        session_name: str,
        error_cls: type[QvacError],
        request_id: str | None = None,
    ) -> None:
        self._upstream = _UpstreamWriter()
        self._events = self._event_stream(transport, wire, process)
        self._session_name = session_name
        self._error_cls = error_cls
        self._consumed = False
        self._closed = False
        self.request_id = request_id

    def write(self, chunk: bytes | str) -> None:
        """Feed an upstream chunk. Text sessions (TTS) accept `str`, encoded
        as UTF-8; audio/neural sessions take raw bytes."""
        if self._closed or self._upstream.closed:
            raise self._error_cls(
                f"{self._session_name}.write() called after end()/close()"
            )
        self._upstream.write(chunk.encode("utf-8") if isinstance(chunk, str) else chunk)

    def end(self) -> None:
        """Signal end of upstream input; downstream keeps flowing until the
        terminal frame."""
        self._upstream.end()

    async def aclose(self) -> None:
        """Tear the session down: closes the upstream and the response
        iterator (which cancels the transport's pump)."""
        self._closed = True
        self._upstream.end()
        await self._events.aclose()

    async def _event_stream(
        self,
        transport: Transport,
        wire: dict[str, Any],
        process: Callable[[dict[str, Any]], Any],
    ) -> AsyncGenerator[T, None]:
        async for chunk in transport.call_duplex(wire, self._upstream.stream()):
            value = process(chunk)
            if value is _DONE:
                return
            if value is not _SKIP:
                yield value

    def __aiter__(self) -> AsyncIterator[T]:
        if self._consumed:
            raise self._error_cls(f"{self._session_name} can only be iterated once")
        self._consumed = True
        return self._events

    async def __aenter__(self) -> DuplexSession[T]:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()


# ---- transcribe_stream_session ---------------------------------------------


def _transcribe_frame(chunk: dict[str, Any]) -> TranscribeStreamResponse | None:
    """Validate one transcribeStream frame; per-frame `error` raises, `done`
    terminates (returns None)."""
    response = TranscribeStreamResponse.model_validate(chunk)
    if response.error:
        raise TranscriptionFailedError(response.error)
    if response.done:
        return None
    return response


def _process_text(chunk: dict[str, Any]) -> Any:
    response = _transcribe_frame(chunk)
    if response is None:
        return _DONE
    if response.text and response.text.strip():
        return response.text
    return _SKIP


def _process_metadata(chunk: dict[str, Any]) -> Any:
    response = _transcribe_frame(chunk)
    if response is None:
        return _DONE
    return response.segment if response.segment is not None else _SKIP


def _process_conversation(wants_metadata: bool) -> Callable[[dict[str, Any]], Any]:
    def process(chunk: dict[str, Any]) -> Any:
        response = _transcribe_frame(chunk)
        if response is None:
            return _DONE
        if response.vad is not None:
            return VadEvent(
                speaking=response.vad.speaking,
                probability=response.vad.probability,
            )
        if response.end_of_turn is not None:
            source = response.end_of_turn.source
            silence = getattr(response.end_of_turn, "silence_duration_ms", None)
            return EndOfTurnEvent(source=source, silence_duration_ms=silence)
        if wants_metadata:
            if response.segment is not None:
                return SegmentEvent(segment=response.segment)
            return _SKIP
        if response.text and response.text.strip():
            return TextEvent(text=response.text)
        return _SKIP

    return process


def transcribe_stream_session(
    transport: Transport,
    *,
    model_id: str,
    prompt: str | None = None,
    metadata: bool = False,
    emit_vad_events: bool = False,
    end_of_turn_silence_ms: float | None = None,
    vad_run_interval_ms: float | None = None,
    parakeet_streaming_config: dict[str, Any] | None = None,
) -> DuplexSession[Any]:
    """Bidirectional transcription session: `write()` raw audio chunks and
    iterate transcription output. Yields plain text by default, transcript
    segments with `metadata=True`, or typed conversation events (VadEvent /
    EndOfTurnEvent / TextEvent / SegmentEvent) when `emit_vad_events=True` or
    a `parakeet_streaming_config` is given -- same mode routing as JS's
    `transcribeStream()`."""
    payload: dict[str, Any] = {"type": "transcribeStream", "modelId": model_id}
    if prompt:
        payload["prompt"] = prompt
    if metadata:
        payload["metadata"] = True
    if emit_vad_events:
        payload["emitVadEvents"] = True
    if end_of_turn_silence_ms is not None:
        payload["endOfTurnSilenceMs"] = end_of_turn_silence_ms
    if vad_run_interval_ms is not None:
        payload["vadRunIntervalMs"] = vad_run_interval_ms
    if parakeet_streaming_config is not None:
        payload["parakeetStreamingConfig"] = parakeet_streaming_config

    request = TranscribeStreamRequest.model_validate(payload)
    wire = request.model_dump(mode="json", by_alias=True, exclude_unset=True)

    conversation = emit_vad_events or parakeet_streaming_config is not None
    if conversation:
        process = _process_conversation(metadata)
        name = "TranscribeStreamConversationSession"
    elif metadata:
        process = _process_metadata
        name = "TranscribeStreamMetadataSession"
    else:
        process = _process_text
        name = "TranscribeStreamSession"

    return DuplexSession(transport, wire, process, name, TranscriptionFailedError)


# ---- bci_transcribe_stream_session ------------------------------------------


def _bci_frame(chunk: dict[str, Any]) -> BciTranscribeStreamResponse | None:
    response = BciTranscribeStreamResponse.model_validate(chunk)
    if response.error:
        raise TranscriptionFailedError(response.error)
    if response.done:
        return None
    return response


def _bci_process_text(chunk: dict[str, Any]) -> Any:
    response = _bci_frame(chunk)
    if response is None:
        return _DONE
    if response.text and response.text.strip():
        return response.text
    return _SKIP


def _bci_process_metadata(chunk: dict[str, Any]) -> Any:
    response = _bci_frame(chunk)
    if response is None:
        return _DONE
    return response.segment if response.segment is not None else _SKIP


def bci_transcribe_stream_session(
    transport: Transport,
    *,
    model_id: str,
    metadata: bool = False,
    window_timesteps: int | None = None,
    hop_timesteps: int | None = None,
    emit: str | None = None,
    request_id: str | None = None,
) -> DuplexSession[Any]:
    """Bidirectional BCI transcription session: `write()` raw neural-signal
    bytes and iterate decoded text (or segments with `metadata=True`). The
    client-generated `request_id` is threaded on the wire and exposed on the
    session for `cancel(request_id=...)`, mirroring JS."""
    from ._api import generate_client_request_id

    resolved_request_id = (
        request_id if request_id is not None else generate_client_request_id()
    )
    stream_opts: dict[str, Any] = {}
    if window_timesteps is not None:
        stream_opts["windowTimesteps"] = window_timesteps
    if hop_timesteps is not None:
        stream_opts["hopTimesteps"] = hop_timesteps
    if emit is not None:
        stream_opts["emit"] = emit

    payload: dict[str, Any] = {
        "type": "bciTranscribeStream",
        "modelId": model_id,
        "requestId": resolved_request_id,
    }
    if metadata:
        payload["metadata"] = True
    if stream_opts:
        payload["streamOpts"] = stream_opts

    request = BciTranscribeStreamRequest.model_validate(payload)
    wire = request.model_dump(mode="json", by_alias=True, exclude_unset=True)

    if metadata:
        process = _bci_process_metadata
        name = "BciTranscribeStreamMetadataSession"
    else:
        process = _bci_process_text
        name = "BciTranscribeStreamSession"

    return DuplexSession(
        transport,
        wire,
        process,
        name,
        TranscriptionFailedError,
        request_id=resolved_request_id,
    )


# ---- text_to_speech_stream_session ------------------------------------------


def _tts_process(chunk: dict[str, Any]) -> Any:
    """TTS yields every validated frame INCLUDING the terminal done frame
    (callers read its final buffer/stats), then terminates -- unlike the
    transcription sessions, which swallow the done frame. Matches JS. The
    wire shape has no per-frame `error` field; in-band error envelopes are
    raised as typed errors by the transport itself."""
    return TextToSpeechStreamResponse.model_validate(chunk)


def text_to_speech_stream_session(
    transport: Transport,
    *,
    model_id: str,
    input_type: str = "text",
    accumulate_sentences: bool | None = None,
    sentence_delimiter_preset: str | None = None,
    max_buffer_scalars: int | None = None,
    flush_after_ms: float | None = None,
) -> DuplexSession[TextToSpeechStreamResponse]:
    """Bidirectional TTS session: `write()` UTF-8 text fragments (e.g. LLM
    token deltas; str or bytes) and iterate TextToSpeechStreamResponse frames
    (PCM in `buffer`, optional `chunk_index`/`sentence_chunk`) until the
    terminal done frame, which IS yielded. Mirrors JS's
    `textToSpeechStream()`."""
    payload: dict[str, Any] = {
        "type": "textToSpeechStream",
        "modelId": model_id,
        "inputType": input_type,
    }
    if accumulate_sentences is not None:
        payload["accumulateSentences"] = accumulate_sentences
    if sentence_delimiter_preset is not None:
        payload["sentenceDelimiterPreset"] = sentence_delimiter_preset
    if max_buffer_scalars is not None:
        payload["maxBufferScalars"] = max_buffer_scalars
    if flush_after_ms is not None:
        payload["flushAfterMs"] = flush_after_ms

    request = TextToSpeechStreamRequest.model_validate(payload)
    wire = request.model_dump(mode="json", by_alias=True, exclude_unset=True)

    session: DuplexSession[TextToSpeechStreamResponse] = _TtsSession(
        transport,
        wire,
        _tts_process,
        "TextToSpeechStreamSession",
        TextToSpeechStreamFailedError,
    )
    return session


class _TtsSession(DuplexSession[TextToSpeechStreamResponse]):
    """TTS terminates on the done frame AFTER yielding it, so the terminal
    check lives in the event stream rather than the processor."""

    async def _event_stream(
        self,
        transport: Transport,
        wire: dict[str, Any],
        process: Callable[[dict[str, Any]], Any],
    ) -> AsyncGenerator[TextToSpeechStreamResponse, None]:
        async for chunk in transport.call_duplex(wire, self._upstream.stream()):
            response = process(chunk)
            yield response
            if response.done:
                return


__all__ = [
    "DuplexSession",
    "TranscribeStreamEvent",
    "VadEvent",
    "EndOfTurnEvent",
    "TextEvent",
    "SegmentEvent",
    "transcribe_stream_session",
    "bci_transcribe_stream_session",
    "text_to_speech_stream_session",
]
