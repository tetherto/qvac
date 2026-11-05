"""Run handles for the streaming methods: one `StreamRun` per call, over the
generated stub. Private until the public shape settles."""

from __future__ import annotations

import asyncio
import base64
from collections.abc import AsyncIterator, Callable, Iterable
from dataclasses import dataclass
from typing import Any, Generic, TypeVar

from ._api import generate_client_request_id
from ._completion import CompletionFinal, _fold_events
from ._generated import methods as _methods
from ._transport import Transport
from .errors import (
    CompletionFailedError,
    InferenceCancelledError,
    InvalidResponseError,
    StreamEndedError,
    TranscriptionFailedError,
)
from .model_types import to_source_union, to_wire_base64
from .schemas import (
    AudioEditStreamRequest,
    AudioGenStreamRequest,
    AudioUnderstandRequest,
    BatchCompletionStreamRequest,
    DiffusionStreamRequest,
    FinetuneRequest,
    OcrStreamRequest,
    TextToSpeechRequest,
    TranscribeRequest,
    UpscaleStreamRequest,
    WorldSceneStreamRequest,
    WorldStepStreamRequest,
)

TItem = TypeVar("TItem")
TResult = TypeVar("TResult")

Side = dict[str, Any]


class _End:
    """Queue sentinel. A plain None could be a legitimate payload."""


_END = _End()


@dataclass(frozen=True)
class TtsAudio:
    samples: list[int]
    sample_rate: int | None


@dataclass(frozen=True)
class GeneratedAudio:
    pcm: bytes
    sample_rate: int
    channels: int
    bits_per_sample: int


@dataclass(frozen=True)
class BatchResult:
    id: str
    final: CompletionFinal


class StreamRun(Generic[TItem, TResult]):
    """One streaming call. Every future settles together when the stream ends."""

    def __init__(self, request_id: str) -> None:
        self.request_id = request_id
        loop = asyncio.get_running_loop()
        self.collected: asyncio.Future[list[TItem]] = loop.create_future()
        self.result: asyncio.Future[TResult] = loop.create_future()
        self.stats: asyncio.Future[Any] = loop.create_future()
        self.done: asyncio.Future[bool] = loop.create_future()
        self._items: asyncio.Queue[Any] = asyncio.Queue()
        self._progress: asyncio.Queue[Any] = asyncio.Queue()

    @property
    def stream(self) -> AsyncIterator[TItem]:
        return self._drain(self._items)

    @property
    def progress_stream(self) -> AsyncIterator[Any]:
        return self._drain(self._progress)

    async def _drain(self, queue: asyncio.Queue[Any]) -> AsyncIterator[Any]:
        while True:
            item = await queue.get()
            if item is _END:
                if self.done.done() and self.done.exception() is not None:
                    raise self.done.exception()  # type: ignore[misc]
                return
            yield item

    def _settle(self, items: list[Any], result: Any, stats: Any) -> None:
        self.collected.set_result(items)
        self.result.set_result(result)
        self.stats.set_result(stats)
        self.done.set_result(True)

    def _fail(self, error: BaseException) -> None:
        for future in (self.collected, self.result, self.stats, self.done):
            if not future.done():
                future.set_exception(error)
                future.add_done_callback(lambda f: f.cancelled() or f.exception())


def _pump(
    run: StreamRun[Any, Any],
    transport: Transport,
    request: Any,
    chunks: Callable[..., AsyncIterator[Any]],
    *,
    items_of: Callable[[Any], Iterable[Any]],
    fold: Callable[[list[Any], Side], Any] = lambda items, _side: items,
    progress_of: Callable[[Any], Iterable[Any]] | None = None,
    side_of: Callable[[Any, Side], None] | None = None,
    terminal_of: Callable[[Any], bool] | None = None,
    unterminated: Callable[[], BaseException] | None = StreamEndedError,
) -> None:
    """Drive one request into `run`. Where `terminal_of` is given, a stream
    closing without that frame fails with `unterminated()`, unless it is None.
    `fold` sees the terminal frame as `side["terminal"]` and may raise."""

    async def run_pump() -> None:
        items: list[Any] = []
        side: Side = {}
        try:
            async for chunk in chunks(transport, request):
                for item in items_of(chunk):
                    items.append(item)
                    run._items.put_nowait(item)
                if progress_of is not None:
                    for tick in progress_of(chunk):
                        run._progress.put_nowait(tick)
                if side_of is not None:
                    side_of(chunk, side)
                if getattr(chunk, "stats", None) is not None:
                    side["stats"] = chunk.stats
                if terminal_of is not None and terminal_of(chunk):
                    side["terminal"] = chunk
                    break
            if terminal_of is not None and "terminal" not in side and unterminated:
                raise unterminated()
            run._settle(items, fold(items, side), side.get("stats"))
        except Exception as error:  # noqa: BLE001 - surfaced on every handle
            run._fail(error)
        finally:
            run._items.put_nowait(_END)
            run._progress.put_nowait(_END)

    asyncio.get_running_loop().create_task(run_pump())


def _is_done(chunk: Any) -> bool:
    return bool(getattr(chunk, "done", False))


def _data(chunk: Any) -> Iterable[bytes]:
    data = getattr(chunk, "data", None)
    return [base64.b64decode(data)] if data else []


def _tick(chunk: Any) -> Iterable[dict[str, Any]]:
    """JS's progress shape: `{ step, totalSteps, elapsedMs }`."""
    step = getattr(chunk, "step", None)
    if step is None:
        return ()
    return (
        {
            "step": step,
            "totalSteps": getattr(chunk, "total_steps", None),
            "elapsedMs": getattr(chunk, "elapsed_ms", None),
        },
    )


def _progress(chunk: Any) -> Iterable[Any]:
    progress = getattr(chunk, "progress", None)
    return () if progress is None else (progress,)


def _last(expected: str) -> Callable[[list[Any], Side], Any]:
    def fold(items: list[Any], _side: Side) -> Any:
        if not items:
            raise InvalidResponseError(expected)
        return items[-1]

    return fold


def _payload(**fields: Any) -> dict[str, Any]:
    return {key: value for key, value in fields.items() if value is not None}


def _start(
    request_type: Any,
    wire_type: str,
    request_id: str | None,
    fields: dict[str, Any],
) -> tuple[str, Any]:
    """OCR, diffusion and upscale carry no request id on the wire, as in JS."""
    resolved = request_id or generate_client_request_id()
    request = request_type.model_validate(
        _payload(type=wire_type, requestId=resolved, **fields)
    )
    return resolved, request


def ocr(
    transport: Transport,
    *,
    model_id: str,
    image: Any,
    options: dict[str, Any] | None = None,
    request_id: str | None = None,
) -> StreamRun[list[Any], list[Any]]:
    """Items are the block batches; the result is every block."""
    resolved, request = _start(
        OcrStreamRequest,
        "ocrStream",
        request_id,
        {"modelId": model_id, "image": to_source_union(image), "options": options},
    )
    run: StreamRun[list[Any], list[Any]] = StreamRun(resolved)
    _pump(
        run,
        transport,
        request,
        _methods.ocr_stream,
        items_of=lambda chunk: [chunk.blocks] if chunk.blocks else [],
        fold=lambda batches, _side: [block for batch in batches for block in batch],
    )
    return run


def transcribe(
    transport: Transport,
    *,
    model_id: str,
    audio: Any,
    request_id: str | None = None,
    **params: Any,
) -> StreamRun[Any, list[Any]]:
    """JS's upfront-audio `transcribe()`: segments under `metadata`, else text."""
    resolved, request = _start(
        TranscribeRequest,
        "transcribe",
        request_id,
        {"modelId": model_id, "audioChunk": to_source_union(audio), **params},
    )
    run: StreamRun[Any, list[Any]] = StreamRun(resolved)

    def pieces(chunk: Any) -> Iterable[Any]:
        if getattr(chunk, "segment", None) is not None:
            return (chunk.segment,)
        return [chunk.text] if getattr(chunk, "text", None) else []

    def failed(chunk: Any, _side: Side) -> None:
        if getattr(chunk, "error", None):
            raise TranscriptionFailedError(chunk.error)

    _pump(
        run,
        transport,
        request,
        _methods.transcribe,
        items_of=pieces,
        side_of=failed,
        terminal_of=_is_done,
        unterminated=None,
    )
    return run


def diffusion(
    transport: Transport, *, model_id: str, request_id: str | None = None, **params: Any
) -> StreamRun[bytes, list[bytes]]:
    params = dict(params)
    if "init_image" in params:
        params["init_image"] = to_wire_base64(params["init_image"])
    if isinstance(params.get("init_images"), (list, tuple)):
        params["init_images"] = [to_wire_base64(item) for item in params["init_images"]]
    resolved, request = _start(
        DiffusionStreamRequest,
        "diffusionStream",
        request_id,
        {"modelId": model_id, **params},
    )
    run: StreamRun[bytes, list[bytes]] = StreamRun(resolved)
    _pump(
        run,
        transport,
        request,
        _methods.diffusion_stream,
        items_of=_data,
        progress_of=_tick,
    )
    return run


def upscale(
    transport: Transport,
    *,
    model_id: str,
    image: Any,
    repeats: int | None = None,
    request_id: str | None = None,
) -> StreamRun[bytes, list[bytes]]:
    resolved, request = _start(
        UpscaleStreamRequest,
        "upscaleStream",
        request_id,
        {"modelId": model_id, "image": to_wire_base64(image), "repeats": repeats},
    )
    run: StreamRun[bytes, list[bytes]] = StreamRun(resolved)
    _pump(
        run,
        transport,
        request,
        _methods.upscale_stream,
        items_of=_data,
        terminal_of=_is_done,
    )
    return run


def world_step(
    transport: Transport,
    *,
    model_id: str,
    keys: Any = None,
    request_id: str | None = None,
) -> StreamRun[bytes, list[bytes]]:
    resolved, request = _start(
        WorldStepStreamRequest,
        "worldStepStream",
        request_id,
        {"modelId": model_id, "keys": keys},
    )
    run: StreamRun[bytes, list[bytes]] = StreamRun(resolved)
    _pump(
        run,
        transport,
        request,
        _methods.world_step_stream,
        items_of=_data,
        progress_of=_tick,
        terminal_of=_is_done,
    )
    return run


def world_create_scene(
    transport: Transport, *, model_id: str, request_id: str | None = None, **params: Any
) -> StreamRun[bytes, bytes | None]:
    """The result is the scene pack, when the request asked for one."""
    resolved, request = _start(
        WorldSceneStreamRequest,
        "worldSceneStream",
        request_id,
        {"modelId": model_id, **params},
    )
    run: StreamRun[bytes, bytes | None] = StreamRun(resolved)
    _pump(
        run,
        transport,
        request,
        _methods.world_scene_stream,
        items_of=_data,
        fold=lambda parts, _side: b"".join(parts) if parts else None,
        terminal_of=_is_done,
    )
    return run


def text_to_speech(
    transport: Transport, *, model_id: str, request_id: str | None = None, **params: Any
) -> StreamRun[int, TtsAudio]:
    resolved, request = _start(
        TextToSpeechRequest, "textToSpeech", request_id, {"modelId": model_id, **params}
    )
    run: StreamRun[int, TtsAudio] = StreamRun(resolved)

    def rate(chunk: Any, side: Side) -> None:
        if chunk.sample_rate is not None:
            side.setdefault("sample_rate", chunk.sample_rate)

    _pump(
        run,
        transport,
        request,
        _methods.text_to_speech,
        items_of=lambda chunk: chunk.buffer or (),
        side_of=rate,
        fold=lambda samples, side: TtsAudio(samples, side.get("sample_rate")),
    )
    return run


def _audio_terminal(request_id: str) -> Callable[[Side], None]:
    """JS's `collectRun`: a cancelled generation rejects."""

    def check(side: Side) -> None:
        stop = getattr(side["terminal"], "stop_reason", None)
        if getattr(stop, "value", stop) == "cancelled":
            raise InferenceCancelledError(request_id)

    return check


def _audio_run(
    transport: Transport, request: Any, request_id: str, wire_type: str, method: Any
) -> StreamRun[bytes, GeneratedAudio]:
    run: StreamRun[bytes, GeneratedAudio] = StreamRun(request_id)
    check = _audio_terminal(request_id)

    def audio_format(chunk: Any, side: Side) -> None:
        # Data frames only, as in JS.
        if getattr(chunk, "data", None):
            for key in ("sample_rate", "channels", "bits_per_sample"):
                side[key] = getattr(chunk, key, None)

    def fold(parts: list[bytes], side: Side) -> GeneratedAudio:
        check(side)
        sample_rate, channels, bits = (
            side.get("sample_rate"),
            side.get("channels"),
            side.get("bits_per_sample"),
        )
        if sample_rate is None or channels is None or bits is None:
            raise InvalidResponseError(f"{wire_type} audio chunk")
        return GeneratedAudio(b"".join(parts), sample_rate, channels, bits)

    _pump(
        run,
        transport,
        request,
        method,
        items_of=_data,
        progress_of=_progress,
        side_of=audio_format,
        terminal_of=_is_done,
        unterminated=lambda: InvalidResponseError(f"{wire_type} terminal response"),
        fold=fold,
    )
    return run


def _with_audio_sources(params: dict[str, Any]) -> dict[str, Any]:
    out = dict(params)
    for key in ("reference_audio", "referenceAudio", "source_audio", "sourceAudio"):
        if key in out:
            out[key] = to_source_union(out[key])
    return out


def audio_gen(
    transport: Transport, *, model_id: str, request_id: str | None = None, **params: Any
) -> StreamRun[bytes, GeneratedAudio]:
    resolved, request = _start(
        AudioGenStreamRequest,
        "audioGenStream",
        request_id,
        {"modelId": model_id, **_with_audio_sources(params)},
    )
    return _audio_run(
        transport, request, resolved, "audioGenStream", _methods.audio_gen_stream
    )


def audio_edit(
    transport: Transport,
    *,
    model_id: str,
    operations: Any,
    request_id: str | None = None,
    **params: Any,
) -> StreamRun[bytes, GeneratedAudio]:
    resolved, request = _start(
        AudioEditStreamRequest,
        "audioEditStream",
        request_id,
        {"modelId": model_id, "operations": operations, **_with_audio_sources(params)},
    )
    return _audio_run(
        transport, request, resolved, "audioEditStream", _methods.audio_edit_stream
    )


def audio_understand(
    transport: Transport, *, model_id: str, request_id: str | None = None, **params: Any
) -> StreamRun[Any, Any]:
    """The result is the last understand payload."""
    resolved, request = _start(
        AudioUnderstandRequest,
        "audioUnderstand",
        request_id,
        {"modelId": model_id, **_with_audio_sources(params)},
    )
    run: StreamRun[Any, Any] = StreamRun(resolved)
    check = _audio_terminal(resolved)
    last = _last("audioUnderstand description")

    def fold(parts: list[Any], side: Side) -> Any:
        check(side)
        return last(parts, side)

    _pump(
        run,
        transport,
        request,
        _methods.audio_understand,
        items_of=lambda chunk: (
            [chunk.understand] if getattr(chunk, "understand", None) else []
        ),
        progress_of=_progress,
        terminal_of=_is_done,
        unterminated=lambda: InvalidResponseError("audioUnderstand terminal response"),
        fold=fold,
    )
    return run


def finetune_run(
    transport: Transport, *, request_id: str | None = None, **params: Any
) -> StreamRun[Any, Any]:
    resolved, request = _start(FinetuneRequest, "finetune", request_id, params)
    run: StreamRun[Any, Any] = StreamRun(resolved)

    def is_reply(chunk: Any) -> bool:
        return getattr(chunk, "type", None) == "finetune"

    _pump(
        run,
        transport,
        request,
        _methods.finetune_with_progress,
        items_of=lambda chunk: [chunk] if is_reply(chunk) else [],
        progress_of=lambda chunk: [] if is_reply(chunk) else [chunk],
        terminal_of=is_reply,
        fold=_last("finetune result"),
    )
    return run


class BatchCompletionRun(StreamRun[Any, list[BatchResult]]):
    """Items are the `{id, event}` records; the result is one `BatchResult` per
    prompt, in prompt order."""

    def __init__(self, request_id: str) -> None:
        super().__init__(request_id)
        self.ids: asyncio.Future[list[str]] = asyncio.get_running_loop().create_future()
        self._outcomes: dict[str, CompletionFinal | BaseException] = {}

    def by_id(self, prompt_id: str) -> asyncio.Future[CompletionFinal]:
        """JS's `byId(id).final`: one failed prompt does not reject the others."""
        future: asyncio.Future[CompletionFinal] = (
            asyncio.get_running_loop().create_future()
        )

        def settle(finished: asyncio.Future[Any]) -> None:
            if finished.exception() is not None and not self._outcomes:
                future.set_exception(finished.exception())  # type: ignore[arg-type]
            else:
                outcome = self._outcomes.get(prompt_id)
                if outcome is None:
                    future.set_exception(
                        CompletionFailedError(f'Unknown batch prompt id "{prompt_id}".')
                    )
                elif isinstance(outcome, BaseException):
                    future.set_exception(outcome)
                else:
                    future.set_result(outcome)
            future.add_done_callback(lambda f: f.exception())

        self.done.add_done_callback(settle)
        return future


def batch_completion(
    transport: Transport,
    *,
    model_id: str,
    prompts: Any,
    request_id: str | None = None,
    **params: Any,
) -> BatchCompletionRun:
    resolved, request = _start(
        BatchCompletionStreamRequest,
        "batchCompletionStream",
        request_id,
        {"modelId": model_id, "prompts": prompts, **params},
    )
    run = BatchCompletionRun(resolved)
    # Without an `ids` frame, JS uses the prompts' ids, then their indices.
    fallback = [
        str(
            prompt.get("id") if isinstance(prompt, dict) and prompt.get("id") else index
        )
        for index, prompt in enumerate(prompts or [])
    ]

    def ids_of(chunk: Any, side: Side) -> None:
        if chunk.ids is not None and "ids" not in side:
            side["ids"] = list(chunk.ids)
            run.ids.set_result(side["ids"])

    def fold(records: list[Any], side: Side) -> list[BatchResult]:
        order = side.get("ids") or fallback
        if not run.ids.done():
            run.ids.set_result(order)
        grouped: dict[str, list[Any]] = {}
        for record in records:
            grouped.setdefault(record.id, []).append(record.event)
        results: list[BatchResult] = []
        first_error: BaseException | None = None
        for prompt_id in order:
            final, error, cancelled = _fold_events(grouped.get(prompt_id, []), {})
            outcome: CompletionFinal | BaseException = final
            if error is not None:
                outcome = CompletionFailedError(error)
            elif cancelled:
                outcome = InferenceCancelledError(
                    resolved,
                    partial_text=final.content_text,
                    partial_tool_calls=final.tool_calls,
                    partial_stats=final.stats,
                )
            run._outcomes[prompt_id] = outcome
            if isinstance(outcome, BaseException):
                first_error = first_error or outcome
            else:
                results.append(BatchResult(prompt_id, final))
        if first_error is not None:
            raise first_error
        return results

    _pump(
        run,
        transport,
        request,
        _methods.batch_completion_stream,
        items_of=lambda chunk: chunk.events or (),
        side_of=ids_of,
        terminal_of=_is_done,
        fold=fold,
    )

    def settle_ids(finished: asyncio.Future[Any]) -> None:
        if not run.ids.done():
            run.ids.set_exception(finished.exception() or StreamEndedError())
            run.ids.add_done_callback(lambda f: f.exception())

    run.done.add_done_callback(settle_ids)
    return run
