"""Ergonomic run handles for the streaming methods.

The generated stubs in `_generated/methods.py` yield the wire envelope as it
arrives: one response model per chunk, each carrying a slice of the payload
plus `done` and `stats`. That is faithful to the protocol and awkward to use,
and it is not what the JS client hands a caller. JS returns a *run*: a live
generator for the pieces, an awaitable for the whole, and an awaitable for the
stats, all from one request.

Callers should not have to fold a stream themselves, and two clients that fold
it differently do not mean the same thing by "the blocks of this page" or "the
frames of this block". So the fold lives here, once, shaped like the JS one --
which is what lets one shared test definition assert the same thing on both.

Every run starts eagerly, like the JS promise: the aggregate resolves whether
or not anyone iterates the generator. Abandoning the generator stops delivery;
it does not stop the native job, which is what `cancel(request_id=...)` is for.

Errors are propagated rather than translated, which is also what JS does: a
transport failure surfaces on whichever handle the caller awaited.
"""

from __future__ import annotations

import asyncio
import base64
from collections.abc import AsyncIterator, Callable, Iterable
from typing import Any, Generic, TypeVar

from ._api import generate_client_request_id
from ._completion import _fold_events
from ._generated import methods as _methods
from ._transport import Transport
from .errors import CompletionFailedError, InvalidResponseError
from .schemas import (
    AudioEditStreamRequest,
    AudioGenStreamRequest,
    AudioUnderstandRequest,
    BatchCompletionStreamRequest,
    DiffusionStreamRequest,
    FinetuneRequest,
    OcrStreamRequest,
    TextToSpeechRequest,
    TranscribeStreamRequest,
    UpscaleStreamRequest,
    WorldSceneStreamRequest,
    WorldStepStreamRequest,
)

TItem = TypeVar("TItem")


class _End:
    """Queue sentinel. A plain None could be a legitimate payload."""


_END = _End()


class StreamRun(Generic[TItem]):
    """One streaming call: the live pieces, the whole, and the stats.

    Two channels, because most of these methods carry two kinds of chunk: the
    payload (blocks, frames, samples) and progress ticks. A method that has no
    progress simply never feeds that channel.
    """

    def __init__(self, request_id: str) -> None:
        self.request_id = request_id
        loop = asyncio.get_running_loop()
        self.collected: asyncio.Future[list[TItem]] = loop.create_future()
        self.stats: asyncio.Future[Any] = loop.create_future()
        self.done: asyncio.Future[bool] = loop.create_future()
        self._items: asyncio.Queue[Any] = asyncio.Queue()
        self._progress: asyncio.Queue[Any] = asyncio.Queue()

    @property
    def stream(self) -> AsyncIterator[TItem]:
        """The payload, piece by piece, as it arrives."""
        return self._drain(self._items)

    @property
    def progress_stream(self) -> AsyncIterator[Any]:
        """Progress ticks, for the methods that emit them."""
        return self._drain(self._progress)

    async def _drain(self, queue: asyncio.Queue[Any]) -> AsyncIterator[Any]:
        while True:
            item = await queue.get()
            if item is _END:
                # The pump ended. If it ended badly, a caller reading only the
                # generator has to see that rather than a silently short stream.
                if self.collected.done() and self.collected.exception() is not None:
                    raise self.collected.exception()  # type: ignore[misc]
                return
            yield item


def _pump(
    run: StreamRun[Any],
    transport: Transport,
    request: Any,
    chunks: Callable[..., AsyncIterator[Any]],
    *,
    items_of: Callable[[Any], Iterable[Any]],
    progress_of: Callable[[Any], Iterable[Any]] | None = None,
) -> None:
    """Drive one request into `run`, then settle every handle it exposes."""

    async def run_pump() -> None:
        gathered: list[Any] = []
        stats: Any = None
        failure: BaseException | None = None
        try:
            async for chunk in chunks(transport, request):
                for item in items_of(chunk):
                    gathered.append(item)
                    run._items.put_nowait(item)
                if progress_of is not None:
                    for tick in progress_of(chunk):
                        run._progress.put_nowait(tick)

                chunk_stats = getattr(chunk, "stats", None)
                if chunk_stats is not None:
                    stats = chunk_stats
        except Exception as error:  # noqa: BLE001 - surfaced on every handle
            failure = error

        # Settled here and only here, in this order. `done` is what the derived
        # handles wait on -- a run's flattened blocks, its assembled audio --
        # and settling it inside the loop, on the terminal chunk, fired those
        # callbacks while `collected` was still empty: they raised
        # InvalidStateError, their own futures never resolved, and every caller
        # awaiting one waited until the test timed out. The ordering is the
        # contract, not an optimisation.
        if failure is not None:
            for future in (run.collected, run.stats, run.done):
                if not future.done():
                    future.set_exception(failure)
                    _silence(future)
        else:
            run.collected.set_result(gathered)
            run.stats.set_result(stats)
            run.done.set_result(True)

        run._items.put_nowait(_END)
        run._progress.put_nowait(_END)

    asyncio.get_running_loop().create_task(run_pump())


def _silence(future: asyncio.Future[Any]) -> None:
    """Mark a future's exception retrieved.

    Every handle on a run carries the same failure and a caller normally awaits
    one of them. Without this the others are collected unretrieved and asyncio
    logs a spurious warning for a failure that was already reported.
    """
    future.add_done_callback(lambda f: f.cancelled() or f.exception())


def _derive(
    run: StreamRun[Any],
    target: asyncio.Future[Any],
    compute: Callable[[list[Any]], Any],
) -> None:
    """Settle `target` from the collected pieces once the run finishes.

    A run exposes handles the pump does not fill directly -- flattened blocks,
    assembled audio, a joined description. They are derived here rather than in
    an ad-hoc callback per method, because the failure mode of getting it wrong
    is silent: a callback that raises leaves its future unresolved and every
    caller awaiting it waits until something else times out. This one cannot
    raise into the event loop; if the run failed, the failure is what the
    derived handle carries.
    """

    def settle(_finished: asyncio.Future[Any]) -> None:
        if target.done():
            return
        try:
            error = run.collected.exception() if run.collected.done() else None
            if error is not None:
                target.set_exception(error)
            else:
                target.set_result(compute(run.collected.result()))
        except Exception as problem:  # noqa: BLE001 - never lose the handle
            target.set_exception(problem)
        _silence(target)

    run.done.add_done_callback(settle)


def _decode(data: str | None) -> bytes:
    """Wire base64 -> the bytes JS hands back as a Uint8Array."""
    return base64.b64decode(data) if data else b""


def _base64(value: Any) -> Any:
    """Raw base64, for the endpoints that take the bytes without a tag."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(value)).decode()
    if isinstance(value, str):
        with open(value, "rb") as handle:
            return base64.b64encode(handle.read()).decode()
    return value


def _encoded_image(value: Any) -> Any:
    """Base64 raw image bytes; leave anything else as the caller spelled it.

    Narrower than `_base64` on purpose: a string here is already an encoded
    image, not a path to read, and silently opening it as a file would turn a
    caller's typo into a confusing filesystem error.
    """
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(value)).decode()
    return value


def _image(value: Any) -> Any:
    """Normalise an image argument the way JS's `ocr()`/`upscale()` do.

    A caller passes a path or the bytes; the wire wants a tagged union. Doing
    this here rather than at every call site is most of what makes these
    wrappers ergonomic, and it is what lets one shared test definition name a
    fixture without knowing which client will run it.
    """
    if isinstance(value, str):
        return {"type": "filePath", "value": value}
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"type": "base64", "value": base64.b64encode(bytes(value)).decode()}
    return value


def _tick(chunk: Any) -> Iterable[dict[str, Any]]:
    """The progress shape JS yields: `{ step, totalSteps, elapsedMs }`."""
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


def _payload(request: Any, **fields: Any) -> dict[str, Any]:
    """Build a wire payload, leaving unset fields out entirely.

    An SDK that tells "absent" from "explicitly null" must see the same call
    the caller meant to make, so a `None` argument is omitted rather than sent.
    """
    return {key: value for key, value in fields.items() if value is not None}


# ---------------------------------------------------------------------------
# OCR
# ---------------------------------------------------------------------------


class OcrRun(StreamRun[Any]):
    """Mirrors JS's `{ blockStream, blocks, stats }`.

    `block_stream` yields a *batch* per chunk, as JS's `blockStream` does, and
    `blocks` is the flattened whole. The distinction matters: a caller written
    against one client and run on the other would otherwise iterate blocks
    where it expected batches, and silently read a block's fields as if they
    were blocks.
    """

    def __init__(self, request_id: str) -> None:
        super().__init__(request_id)
        self.blocks: asyncio.Future[list[Any]] = (
            asyncio.get_running_loop().create_future()
        )

    @property
    def block_stream(self) -> AsyncIterator[Any]:
        return self.stream


def ocr(
    transport: Transport,
    *,
    model_id: str,
    image: Any,
    options: dict[str, Any] | None = None,
    request_id: str | None = None,
) -> OcrRun:
    """Recognise text in an image. Mirrors JS's `ocr()`."""
    resolved = request_id or generate_client_request_id()
    request = OcrStreamRequest.model_validate(
        _payload(
            None,
            type="ocrStream",
            modelId=model_id,
            image=_image(image),
            options=options,
        )
    )
    run = OcrRun(resolved)
    _pump(
        run,
        transport,
        request,
        _methods.ocr_stream,
        # One item per chunk -- the batch -- so the generator yields what JS's
        # blockStream yields.
        items_of=lambda chunk: (chunk.blocks,) if chunk.blocks else (),
    )

    _derive(
        run, run.blocks, lambda batches: [block for batch in batches for block in batch]
    )
    return run


# ---------------------------------------------------------------------------
# Diffusion and upscaling
# ---------------------------------------------------------------------------


class ImagesRun(StreamRun[bytes]):
    """Mirrors JS's `{ progressStream, outputs, stats }`."""

    @property
    def outputs(self) -> asyncio.Future[list[bytes]]:
        return self.collected


def diffusion(
    transport: Transport, *, model_id: str, request_id: str | None = None, **params: Any
) -> ImagesRun:
    """Generate images. Mirrors JS's `diffusion()`.

    Extra keys pass through as the wire spells them, so a caller uses the same
    names the JS client and the contract use (`cfg_scale`, `init_image`, ...).

    The img2img inputs are the exception: `init_image` and `init_images` carry
    an encoded image on the wire, and a caller holding raw bytes -- which is
    what reading a file gives, and what the JS client accepts -- would
    otherwise be refused by the request model for not being a string.
    """
    resolved = request_id or generate_client_request_id()
    params = dict(params)
    if "init_image" in params:
        params["init_image"] = _encoded_image(params["init_image"])
    if isinstance(params.get("init_images"), (list, tuple)):
        params["init_images"] = [_encoded_image(item) for item in params["init_images"]]
    request = DiffusionStreamRequest.model_validate(
        _payload(None, type="diffusionStream", modelId=model_id, **params)
    )
    run = ImagesRun(resolved)
    _pump(
        run,
        transport,
        request,
        _methods.diffusion_stream,
        items_of=lambda chunk: (_decode(chunk.data),) if chunk.data else (),
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
) -> ImagesRun:
    """Upscale an image. Mirrors JS's `upscale()`: `{ outputs, stats }`."""
    resolved = request_id or generate_client_request_id()
    request = UpscaleStreamRequest.model_validate(
        _payload(
            None,
            type="upscaleStream",
            modelId=model_id,
            # `upscale` takes bare base64, not the tagged union the OCR and
            # diffusion endpoints take -- JS calls `encodeBase64` here rather
            # than its image normaliser. Passing the union failed validation
            # before the request left the process.
            image=_base64(image),
            repeats=repeats,
        )
    )
    run = ImagesRun(resolved)
    _pump(
        run,
        transport,
        request,
        _methods.upscale_stream,
        items_of=lambda chunk: (_decode(chunk.data),) if chunk.data else (),
    )
    return run


# ---------------------------------------------------------------------------
# Text to speech
# ---------------------------------------------------------------------------


class TtsRun(StreamRun[int]):
    """Mirrors JS's `{ bufferStream, buffer, done, sampleRate, requestId }`.

    The PCM arrives as runs of samples; `buffer_stream` yields them one sample
    at a time, as JS does, and `buffer` resolves to all of them.
    """

    def __init__(self, request_id: str) -> None:
        super().__init__(request_id)
        self.sample_rate: asyncio.Future[int | None] = (
            asyncio.get_running_loop().create_future()
        )

    @property
    def buffer_stream(self) -> AsyncIterator[int]:
        return self.stream

    @property
    def buffer(self) -> asyncio.Future[list[int]]:
        return self.collected


def text_to_speech(
    transport: Transport, *, model_id: str, request_id: str | None = None, **params: Any
) -> TtsRun:
    """Synthesise speech. Mirrors JS's `textToSpeech()`."""
    resolved = request_id or generate_client_request_id()
    # The server-stream request, not the duplex one. JS uses `streamRpc` for
    # plain synthesis and `duplex` only for the interactive session; driving
    # the duplex stub here ended the call before any audio arrived, so TTS
    # came back with zero samples on every run. The interactive form is
    # `sessions.text_to_speech_stream_session`.
    request = TextToSpeechRequest.model_validate(
        _payload(
            None,
            type="textToSpeech",
            modelId=model_id,
            requestId=resolved,
            **params,
        )
    )
    run = TtsRun(resolved)

    def samples(chunk: Any) -> Iterable[int]:
        if chunk.sample_rate is not None and not run.sample_rate.done():
            run.sample_rate.set_result(chunk.sample_rate)
        return chunk.buffer or ()

    # `text_to_speech_stream` is the duplex stub and wants an upstream. Plain
    # synthesis carries its text in the request, so the upstream is closed
    # immediately -- without it the call raised TypeError before any audio was
    # asked for, which meant non-session TTS did not work from Python at all.
    # The interactive form is `sessions.text_to_speech_stream_session`.
    _pump(run, transport, request, _methods.text_to_speech, items_of=samples)
    # The rate may never arrive on a failed or empty run; settle it with the
    # rest rather than leaving a caller awaiting it for ever.
    run.done.add_done_callback(
        lambda _f: run.sample_rate.done() or run.sample_rate.set_result(None)
    )
    return run


# ---------------------------------------------------------------------------
# Audio generation, editing and understanding
# ---------------------------------------------------------------------------


class AudioRun(StreamRun[bytes]):
    """Mirrors JS's `{ requestId, progressStream, audio, stats }`.

    `audio` is the assembled PCM plus the format it is in, because a caller
    that has the bytes without the sample rate cannot play or compare them.
    """

    def __init__(self, request_id: str) -> None:
        super().__init__(request_id)
        loop = asyncio.get_running_loop()
        self.audio: asyncio.Future[dict[str, Any]] = loop.create_future()


def _audio_run(
    transport: Transport, request: Any, request_id: str, method: Any
) -> AudioRun:
    run = AudioRun(request_id)
    format_seen: dict[str, Any] = {}

    def chunks_of(chunk: Any) -> Iterable[bytes]:
        for key in ("sample_rate", "channels", "bits_per_sample"):
            value = getattr(chunk, key, None)
            if value is not None:
                format_seen[key] = value
        return (_decode(chunk.data),) if chunk.data else ()

    _pump(
        run,
        transport,
        request,
        method,
        items_of=chunks_of,
        progress_of=lambda chunk: (
            (chunk.progress,) if getattr(chunk, "progress", None) is not None else ()
        ),
    )

    _derive(
        run,
        run.audio,
        lambda parts: {
            "data": b"".join(parts),
            "sampleRate": format_seen.get("sample_rate"),
            "channels": format_seen.get("channels"),
            "bitsPerSample": format_seen.get("bits_per_sample"),
        },
    )
    return run


def _audio_source(value: Any) -> Any:
    """Normalise a reference/source audio argument into its wire union.

    The wire takes `{type: "filePath"}` or `{type: "base64"}`, and JS normalises
    into it inside `audioGenClientAudioInputSchema` before the request is built:
    a string is a path the server decodes, raw bytes are interleaved stereo
    48 kHz Float32 LE PCM. Without the same step here a caller holding either
    form is refused by the request model before the call goes out.
    """
    if isinstance(value, str):
        return {"type": "filePath", "value": value}
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"type": "base64", "value": base64.b64encode(bytes(value)).decode()}
    return value


def _with_audio_sources(params: dict[str, Any]) -> dict[str, Any]:
    """Apply `_audio_source` to every audio input an audiogen request carries."""
    out = dict(params)
    for key in ("reference_audio", "referenceAudio", "source_audio", "sourceAudio"):
        if key in out:
            out[key] = _audio_source(out[key])
    return out


def audio_gen(
    transport: Transport, *, model_id: str, request_id: str | None = None, **params: Any
) -> AudioRun:
    """Generate audio. Mirrors JS's `audioGen()`."""
    resolved = request_id or generate_client_request_id()
    request = AudioGenStreamRequest.model_validate(
        _payload(
            None,
            type="audioGenStream",
            modelId=model_id,
            requestId=resolved,
            **_with_audio_sources(params),
        )
    )
    return _audio_run(transport, request, resolved, _methods.audio_gen_stream)


def audio_edit(
    transport: Transport,
    *,
    model_id: str,
    operations: Any,
    request_id: str | None = None,
    **params: Any,
) -> AudioRun:
    """Edit audio. Mirrors JS's `audioEdit()`; same run shape as `audio_gen`."""
    resolved = request_id or generate_client_request_id()
    request = AudioEditStreamRequest.model_validate(
        _payload(
            None,
            type="audioEditStream",
            modelId=model_id,
            operations=operations,
            requestId=resolved,
            **_with_audio_sources(params),
        )
    )
    return _audio_run(transport, request, resolved, _methods.audio_edit_stream)


class AudioUnderstandRun(StreamRun[Any]):
    """Mirrors JS's `{ progressStream, description, stats }` -- shaped like the
    audio runs, except the run produces a description rather than audio.

    `description` is the whole understand payload -- caption, bpm, keyscale,
    recovered codes -- not a string. JS settles it from `stats.understand`,
    falling back to the last `understand` frame it absorbed, and the two carry
    the same object.
    """

    def __init__(self, request_id: str) -> None:
        super().__init__(request_id)
        self.description: asyncio.Future[Any] = (
            asyncio.get_running_loop().create_future()
        )


def audio_understand(
    transport: Transport, *, model_id: str, request_id: str | None = None, **params: Any
) -> AudioUnderstandRun:
    """Describe audio. Mirrors JS's `audioUnderstand()`."""
    resolved = request_id or generate_client_request_id()
    request = AudioUnderstandRequest.model_validate(
        _payload(
            None,
            type="audioUnderstand",
            modelId=model_id,
            requestId=resolved,
            **_with_audio_sources(params),
        )
    )
    run = AudioUnderstandRun(resolved)
    _pump(
        run,
        transport,
        request,
        _methods.audio_understand,
        items_of=lambda chunk: (
            (chunk.understand,) if getattr(chunk, "understand", None) else ()
        ),
        progress_of=lambda chunk: (
            (chunk.progress,) if getattr(chunk, "progress", None) is not None else ()
        ),
    )

    def last_understand(parts: list[Any]) -> Any:
        if not parts:
            raise InvalidResponseError("audioUnderstand description")
        return parts[-1]

    _derive(run, run.description, last_understand)
    return run


# ---------------------------------------------------------------------------
# Finetune
# ---------------------------------------------------------------------------


class FinetuneRun(StreamRun[Any]):
    """Mirrors JS's `{ progressStream, result }`.

    Progress ticks and the terminal reply arrive on one stream, told apart by
    each payload's own `type`: the reply carries `type: "finetune"` and a
    status, a tick carries the training counters. `result` settles from the
    reply, so a caller awaiting it does not have to read the ticks first.
    """

    def __init__(self, request_id: str) -> None:
        super().__init__(request_id)
        self.result: asyncio.Future[Any] = asyncio.get_running_loop().create_future()


def finetune_run(
    transport: Transport, *, request_id: str | None = None, **params: Any
) -> FinetuneRun:
    """Start a finetune and hand back its run. Mirrors JS's `finetune()`.

    A control operation -- pause, resume, stop -- is a plain call that
    resolves and emits no progress; it has no run, and `finetune()` in
    `_api` is the call for it.
    """
    resolved = request_id or generate_client_request_id()
    request = FinetuneRequest.model_validate(
        _payload(None, type="finetune", requestId=resolved, **params)
    )
    run = FinetuneRun(resolved)

    def terminal_of(chunk: Any) -> Iterable[Any]:
        return (chunk,) if getattr(chunk, "type", None) == "finetune" else ()

    def progress_of(chunk: Any) -> Iterable[Any]:
        return () if getattr(chunk, "type", None) == "finetune" else (chunk,)

    _pump(
        run,
        transport,
        request,
        _methods.finetune_with_progress,
        items_of=terminal_of,
        progress_of=progress_of,
    )

    def only_reply(parts: list[Any]) -> Any:
        if not parts:
            raise InvalidResponseError("finetune result")
        return parts[-1]

    _derive(run, run.result, only_reply)
    return run


# ---------------------------------------------------------------------------
# World model
# ---------------------------------------------------------------------------


class WorldStepRun(StreamRun[bytes]):
    """Mirrors JS's `{ requestId, frameStream, frames, progressStream }`."""

    @property
    def frame_stream(self) -> AsyncIterator[bytes]:
        return self.stream

    @property
    def frames(self) -> asyncio.Future[list[bytes]]:
        return self.collected


def world_step(
    transport: Transport,
    *,
    model_id: str,
    keys: Any = None,
    request_id: str | None = None,
) -> WorldStepRun:
    """Walk one block of a world. Mirrors JS's `worldStep()`."""
    resolved = request_id or generate_client_request_id()
    request = WorldStepStreamRequest.model_validate(
        _payload(
            None,
            type="worldStepStream",
            modelId=model_id,
            requestId=resolved,
            keys=keys,
        )
    )
    run = WorldStepRun(resolved)
    _pump(
        run,
        transport,
        request,
        _methods.world_step_stream,
        items_of=lambda chunk: (_decode(chunk.data),) if chunk.data else (),
        progress_of=_tick,
    )
    return run


class WorldSceneRun(StreamRun[bytes]):
    """Mirrors JS's `{ requestId, stats }`, plus `scene` when the request asked
    for the pack. JS splits that into two types so the bytes cannot be awaited
    on a request that never asked for them; Python resolves `scene` to `None`
    instead, which is the same guarantee one layer down."""

    def __init__(self, request_id: str) -> None:
        super().__init__(request_id)
        self.scene: asyncio.Future[bytes | None] = (
            asyncio.get_running_loop().create_future()
        )


def world_create_scene(
    transport: Transport, *, model_id: str, request_id: str | None = None, **params: Any
) -> WorldSceneRun:
    """Create a world scene. Mirrors JS's `worldCreateScene()`."""
    resolved = request_id or generate_client_request_id()
    request = WorldSceneStreamRequest.model_validate(
        _payload(
            None,
            type="worldSceneStream",
            modelId=model_id,
            requestId=resolved,
            **params,
        )
    )
    run = WorldSceneRun(resolved)
    _pump(
        run,
        transport,
        request,
        _methods.world_scene_stream,
        items_of=lambda chunk: (_decode(chunk.data),) if chunk.data else (),
    )

    _derive(run, run.scene, lambda parts: b"".join(parts) if parts else None)
    return run


# ---------------------------------------------------------------------------
# Batch completion
# ---------------------------------------------------------------------------


class BatchCompletionRun(StreamRun[Any]):
    """Mirrors JS's `{ events, results, ids }`."""

    def __init__(self, request_id: str) -> None:
        super().__init__(request_id)
        loop = asyncio.get_running_loop()
        self.ids: asyncio.Future[list[Any]] = loop.create_future()
        #: Per-prompt finals in prompt order, as JS's `results` gives them.
        self.results: asyncio.Future[list[Any]] = loop.create_future()

    @property
    def events(self) -> AsyncIterator[Any]:
        return self.stream

    def by_id(self, prompt_id: str) -> asyncio.Future[Any]:
        """The final for one prompt, as JS's `byId(id).final` gives it."""
        loop = asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()

        def settle(_done: Any) -> None:
            if future.done():
                return
            error = self.results.exception()
            if error is not None:
                future.set_exception(error)
                return
            for result in self.results.result():
                if result["id"] == prompt_id:
                    future.set_result(result["final"])
                    return
            future.set_exception(
                CompletionFailedError(f'Unknown batch prompt id "{prompt_id}".')
            )

        self.results.add_done_callback(settle)
        return future


def batch_completion(
    transport: Transport,
    *,
    model_id: str,
    prompts: Any,
    request_id: str | None = None,
    **params: Any,
) -> BatchCompletionRun:
    """Run several prompts against one model. Mirrors JS's `batchCompletion()`."""
    resolved = request_id or generate_client_request_id()
    request = BatchCompletionStreamRequest.model_validate(
        _payload(
            None,
            type="batchCompletionStream",
            modelId=model_id,
            prompts=prompts,
            requestId=resolved,
            **params,
        )
    )
    run = BatchCompletionRun(resolved)

    def events_of(chunk: Any) -> Iterable[Any]:
        if chunk.ids is not None and not run.ids.done():
            run.ids.set_result(chunk.ids)
        return chunk.events or ()

    _pump(run, transport, request, _methods.batch_completion_stream, items_of=events_of)
    run.done.add_done_callback(
        lambda _f: run.ids.done() or run.ids.set_result([]),
    )

    def per_prompt(events: list[Any]) -> list[Any]:
        """Fold the interleaved event stream into one final per prompt.

        The wire carries `{id, event}` pairs for every prompt on one stream;
        JS regroups them behind `results`, and without the same regrouping
        here `results` would mean "the raw events" on Python and "the per
        prompt finals" on JS -- the same catalog step reading two different
        things.
        """
        grouped: dict[str, list[Any]] = {}
        for item in events:
            grouped.setdefault(item.id, []).append(item.event)
        order = run.ids.result() if run.ids.done() else list(grouped)
        results = []
        for prompt_id in order:
            final, _error, _cancelled = _fold_events(grouped.get(prompt_id, []), {})
            results.append({"id": prompt_id, "final": final})
        return results

    _derive(run, run.results, per_prompt)
    return run


# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------


def transcribe_stream_run(
    transport: Transport, *, model_id: str, request_id: str | None = None, **params: Any
) -> StreamRun[Any]:
    """Transcribe, as a run rather than a bare generator.

    JS's `transcribeStream` returns the generator directly; the run adds the
    aggregate the catalog needs to assert on a whole transcript without the
    caller folding it, and `stream` is still the generator for a caller that
    wants segments live.
    """
    resolved = request_id or generate_client_request_id()
    request = TranscribeStreamRequest.model_validate(
        _payload(
            None,
            type="transcribeStream",
            modelId=model_id,
            requestId=resolved,
            **params,
        )
    )
    run: StreamRun[Any] = StreamRun(resolved)
    _pump(
        run,
        transport,
        request,
        _methods.transcribe_stream,
        items_of=lambda chunk: (
            (chunk.segment,)
            if getattr(chunk, "segment", None) is not None
            else ((chunk.text,) if getattr(chunk, "text", None) else ())
        ),
    )
    return run
