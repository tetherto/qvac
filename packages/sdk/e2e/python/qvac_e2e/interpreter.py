"""Executes a declarative test body.

The interpreter is the whole cost of a new client: it grows with the size of
the step vocabulary, not with the size of the catalog. An operation it does
not implement yet produces `incomplete` -- the test applies to this client,
the client simply cannot run it -- which keeps a thin client from looking
green.

Calls go through the generated typed methods on purpose, never straight to
the transport. The point of the exercise is to prove the *client* behaves like
the JS client; bypassing it would prove only that the worker works.
"""

from __future__ import annotations

import asyncio
import base64
import dataclasses
import math
import shutil
import tempfile
import time
import re
import sys
from array import array
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from dataclasses import asdict, dataclass, is_dataclass, replace
from typing import Any

from tetherto.qvac_sdk import (
    BciTranscribeRequest,
    ClassifyRequest,
    DownloadAssetRequest,
    EmbedRequest,
    FinetuneRequest,
    GetLoadedModelInfoRequest,
    GetModelInfoRequest,
    GetSystemResourcesRequest,
    HeartbeatRequest,
    RagRequest,
    ResumeRequest,
    StateRequest,
    SuspendRequest,
    TranscribeRequest,
    VectorIndexRequest,
    bci_transcribe,
    cancel,
    classify,
    completion,
    delete_cache,
    download_asset,
    embed,
    finetune,
    finetune_run,
    get_loaded_model_info,
    get_model_info,
    get_system_resources,
    heartbeat,
    invoke_plugin,
    load_model,
    model_registry_get_model,
    model_registry_list,
    model_registry_search,
    reconstruct_error,
    rag,
    resume,
    state,
    suspend,
    transcribe,
    SDK_LOG_ID,
    bci_transcribe_stream_session,
    logging_stream,
    transcribe_stream_session,
    audio_edit,
    audio_gen,
    audio_understand,
    batch_completion,
    diffusion,
    invoke_plugin_stream,
    ocr,
    text_to_speech,
    transcribe_stream_run,
    translate,
    upscale,
    world_step,
    unload_model,
    vector_index,
    vla,
    vla_hparams,
    vla_set_embodiment,
)

from tetherto.qvac_sdk.model_types import model_src_to_wire

from .assertions import ASSERTIONS, COMPARISONS
from .resources import ASSET_ROOT, ResourceManager, UnknownResourceError
from .result import StepResult, js_string
from .wav_pcm import decode_wav_to_mono_f32, f32_to_le_bytes, f32_to_s16_le_bytes
from .validation import validate


# method name (as it appears in the contract manifest) -> how to call it here.
#
# Each entry takes the transport and the step's already-resolved params and
# adapts them to whatever this client's signature happens to be: a request
# model for the generated stubs, keyword arguments for the hand-written
# ergonomic wrappers, positional arguments for `model_registry_get_model`.
# Adapting is the binding's whole job -- the contract name and the params
# object are what the two clients agree on, not the calling convention.
#
# Deliberately explicit rather than reflective: a typo in a step should be an
# `incomplete` with a clear reason, not an attribute error deep in a stream.
#: Open transcription sessions, by an id this client hands out. The worker
#: assigns none, so one is minted: what matters is that the catalog can name
#: the session it opened without holding the object.
_TRANSCRIBE_SESSIONS: dict[str, Any] = {}
_TRANSCRIBE_SESSION_SEQ = 0

#: Conversation events arrive as frozen dataclasses with snake_case fields,
#: where JS yields plain records. Renamed here so a catalog body reads one
#: shape on both clients.
_EVENT_FIELDS = {
    "silence_duration_ms": "silenceDurationMs",
    "is_end_of_turn": "isEndOfTurn",
    "start_ms": "startMs",
    "end_ms": "endMs",
    "starts_word": "startsWord",
}


def _normalise_transcribe_event(event: Any) -> dict[str, Any]:
    """One event as the catalog sees it.

    The plain session yields bare strings and the conversation session yields
    typed objects; both become `{"type": ...}` records so a body can count
    event types without knowing which mode the session was opened in.
    """
    if isinstance(event, str):
        return {"type": "text", "text": event}
    if is_dataclass(event) and not isinstance(event, type):
        raw = asdict(event)
    elif isinstance(event, dict):
        raw = dict(event)
    elif hasattr(event, "model_dump"):
        # A metadata session yields the segment model itself, with no wrapper.
        # JS spreads the same event, so its fields have to be the record's own
        # fields here too -- boxing it as `{type, value}` left the catalog
        # asserting the segment shape against an object with no `text`.
        raw = event.model_dump(mode="json", by_alias=True)
    else:
        raw = {"type": type(event).__name__, "value": _jsonable(event)}
    return {
        _EVENT_FIELDS.get(key, key): _jsonable(value)
        for key, value in raw.items()
        if value is not None
    }


def _transcribe_session(session_id: str) -> Any:
    session = _TRANSCRIBE_SESSIONS.get(session_id)
    if session is None:
        raise StepError(f'transcription session "{session_id}" is not open')
    return session


async def _transcribe_stream_open(transport: Any, params: dict[str, Any]) -> Any:
    global _TRANSCRIBE_SESSION_SEQ
    session = transcribe_stream_session(
        transport,
        model_id=params["modelId"],
        metadata=params.get("metadata", False),
        emit_vad_events=params.get("emitVadEvents", False),
        end_of_turn_silence_ms=params.get("endOfTurnSilenceMs"),
        parakeet_streaming_config=params.get("parakeetStreamingConfig"),
    )
    _TRANSCRIBE_SESSION_SEQ += 1
    session_id = f"session-{_TRANSCRIBE_SESSION_SEQ}"
    _TRANSCRIBE_SESSIONS[session_id] = session
    return {"sessionId": session_id}


async def _transcribe_stream_write(transport: Any, params: dict[str, Any]) -> Any:
    """Feeds a WAV fixture in, paced.

    Parakeet's stream session is built for live audio and only emits segments
    when the feed is wall-clock paced -- flooding the duplex RPC with the whole
    clip at once comes back with nothing. `chunkMs` is therefore both the chunk
    size and the delay between chunks, and `trailingSilenceMs` is the pad that
    lets end-of-turn detection fire.
    """
    session = _transcribe_session(params["sessionId"])
    decoded = decode_wav_to_mono_f32(bytes(params["audio"]))
    expected = params.get("expectSampleRate", 16000)
    if decoded.sample_rate != expected:
        raise StepError(
            f"fixture sample rate {decoded.sample_rate} != expected {expected}"
        )
    chunk_ms = params["chunkMs"]
    wide = params.get("sampleFormat") == "f32le"
    bytes_per_sample = 4 if wide else 2
    speech = (
        f32_to_le_bytes(decoded.samples_mono)
        if wide
        else f32_to_s16_le_bytes(decoded.samples_mono)
    )
    silence_samples = int(
        params.get("trailingSilenceMs", 0) / 1000 * decoded.sample_rate
    )
    silence = bytes(silence_samples * bytes_per_sample)
    chunk_size = int(chunk_ms / 1000 * decoded.sample_rate) * bytes_per_sample
    delay = 0 if params.get("pace") is False else chunk_ms / 1000

    chunks = 0
    for payload in (speech, silence):
        for offset in range(0, len(payload), chunk_size):
            session.write(payload[offset : offset + chunk_size])
            chunks += 1
            if delay > 0 and offset + chunk_size < len(payload):
                await asyncio.sleep(delay)
    return {"chunks": chunks, "bytes": len(speech) + len(silence)}


async def _transcribe_stream_write_chunks(
    transport: Any, params: dict[str, Any]
) -> Any:
    """Writes a fixed number of chunks and stops, for the teardown tests."""
    session = _transcribe_session(params["sessionId"])
    decoded = decode_wav_to_mono_f32(bytes(params["audio"]))
    speech = f32_to_s16_le_bytes(decoded.samples_mono)
    chunk_size = int(params["chunkMs"] / 1000 * decoded.sample_rate) * 2
    written = 0
    for index in range(params["chunks"]):
        offset = index * chunk_size
        if offset >= len(speech):
            break
        session.write(speech[offset : offset + chunk_size])
        written += 1
    return {"chunks": written}


#: Open log streams, by an id this client hands out. Kept in step with the JS
#: bindings: three steps rather than one, because the stream has to be open
#: before the operation that produces the logs runs, the cutoff has to be taken
#: when that operation starts -- otherwise buffered load logs satisfy the target
#: on their own -- and only then can the reading be bounded.
_LOGGING_STREAMS: dict[str, dict[str, Any]] = {}
_LOGGING_STREAM_SEQ = 0


def _logging_state(stream_id: str) -> dict[str, Any]:
    state = _LOGGING_STREAMS.get(stream_id)
    if state is None:
        raise StepError(f'log stream "{stream_id}" is not open')
    return state


async def _logging_stream_open(transport: Any, params: dict[str, Any]) -> Any:
    global _LOGGING_STREAM_SEQ
    target_id = params.get("id") or SDK_LOG_ID
    _LOGGING_STREAM_SEQ += 1
    stream_id = f"logs-{_LOGGING_STREAM_SEQ}"
    state: dict[str, Any] = {"collected": [], "cutoffMs": 0, "done": False}
    _LOGGING_STREAMS[stream_id] = state

    async def pump() -> None:
        try:
            async for entry in logging_stream(transport, target_id):
                if state["done"]:
                    break
                state["collected"].append(_jsonable(entry))
        except Exception:  # noqa: BLE001 - an unknown id just closes the stream
            pass

    # Read in the background: the catalog triggers the operation between this
    # step and the collect, and nothing would be listening in between.
    state["pump"] = asyncio.ensure_future(pump())
    return {"streamId": stream_id}


async def _logging_stream_mark(transport: Any, params: dict[str, Any]) -> Any:
    """Marks the point the logs are counted from."""
    state = _logging_state(params["streamId"])
    state["cutoffMs"] = time.time() * 1000
    return {"markedAt": state["cutoffMs"]}


async def _logging_stream_collect(transport: Any, params: dict[str, Any]) -> Any:
    """Reads until enough entries arrive past the mark, or the window closes.

    The window is a bound, not a wait: a test that got its entries early
    returns as soon as it has them.
    """
    state = _logging_state(params["streamId"])
    target = int(params.get("target") or 1)
    deadline = time.monotonic() + (float(params.get("timeoutMs") or 5000) / 1000)

    def since() -> list[Any]:
        return [
            entry
            for entry in state["collected"]
            if (entry or {}).get("timestamp", 0) >= state["cutoffMs"]
        ]

    while len(since()) < target and time.monotonic() < deadline:
        await asyncio.sleep(0.05)
    return {"entries": since()}


async def _logging_stream_close(transport: Any, params: dict[str, Any]) -> Any:
    """Closes the stream, on both paths."""
    stream_id = params.get("streamId")
    state = _LOGGING_STREAMS.pop(stream_id, None) if stream_id else None
    if state is None:
        return {"closed": False}
    state["done"] = True
    return {"closed": True}


async def _bci_transcribe_stream_open(transport: Any, params: dict[str, Any]) -> Any:
    """The BCI duplex session, in the same registry as the transcription ones.

    Its input is raw neural samples rather than audio, so it has its own open
    and its own write; everything after that -- end, drain, destroy -- is the
    same session surface.
    """
    global _TRANSCRIBE_SESSION_SEQ
    session = bci_transcribe_stream_session(
        transport,
        model_id=params["modelId"],
        **{k: v for k, v in params.items() if k != "modelId"},
    )
    _TRANSCRIBE_SESSION_SEQ += 1
    session_id = f"session-{_TRANSCRIBE_SESSION_SEQ}"
    _TRANSCRIBE_SESSIONS[session_id] = session
    return {"sessionId": session_id}


async def _transcribe_stream_write_bytes(transport: Any, params: dict[str, Any]) -> Any:
    """Writes a fixture in fixed-size chunks, with no decoding.

    The neural fixture is already in the form the addon wants, so unlike the
    audio writer this one does not touch the bytes -- which is the whole
    difference between the two inputs.
    """
    session = _transcribe_session(params["sessionId"])
    data = bytes(params["data"])
    chunk_bytes = int(params["chunkBytes"])
    chunks = 0
    for offset in range(0, len(data), chunk_bytes):
        session.write(data[offset : offset + chunk_bytes])
        chunks += 1
    return {"chunks": chunks, "bytes": len(data)}


async def _transcribe_stream_end(transport: Any, params: dict[str, Any]) -> Any:
    _transcribe_session(params["sessionId"]).end()
    return {"ended": True}


async def _transcribe_stream_destroy(transport: Any, params: dict[str, Any]) -> Any:
    """Tears the session down and forgets it.

    Tolerant of a session already gone: teardown runs on the failure path too,
    and a body that failed before opening one must not fail again here.
    """
    session_id = params.get("sessionId")
    session = _TRANSCRIBE_SESSIONS.pop(session_id, None) if session_id else None
    if session is None:
        return {"destroyed": False}
    try:
        await session.aclose()
    except Exception:  # noqa: BLE001 - already torn down by the iterator
        pass
    return {"destroyed": True}


async def _transcribe_stream_drain(
    transport: Any, params: dict[str, Any], collect: str
) -> Any:
    """Reads the session's events to the end, or up to `abortAfter` of them.

    `abortAfter` is the consumer-disconnect path: the iterator is thrown into
    after that many events, which must unwind the session cleanly. A body that
    merely stopped reading would prove nothing -- the question is what happens
    when the consumer goes away mid-stream.
    """
    if collect != "events":
        raise StepError(
            f'collect: "{collect}" is not defined for transcribeStreamDrain',
            incomplete=True,
        )
    session = _transcribe_session(params["sessionId"])
    abort_after = params.get("abortAfter")
    events: list[dict[str, Any]] = []
    iterator = session.__aiter__()
    while True:
        try:
            event = await iterator.__anext__()
        except StopAsyncIteration:
            break
        events.append(_normalise_transcribe_event(event))
        if abort_after is not None and len(events) >= abort_after:
            # `athrow` rather than `aclose`: the contract under test is that
            # the session unwinds when the consumer errors, not when it
            # finishes.
            with suppress(BaseException):
                await iterator.athrow(RuntimeError("consumer aborted the stream"))
            break
    return {"events": events, "stats": _jsonable(session.stats)}


async def _invoke_plugin(transport: Any, params: dict[str, Any]) -> Any:
    """A plugin call, bound the way JS binds it.

    JS wraps the handler's return value as `{ result }` so a later step has a
    field to project; Python returned it bare, so `$run.result.message`
    resolved against nothing.
    """
    return {
        "result": _jsonable(
            await invoke_plugin(
                transport,
                model_id=params["modelId"],
                handler=params["handler"],
                params=params.get("params"),
            )
        )
    }


async def _get_model_info(transport: Any, params: dict[str, Any]) -> Any:
    """Registry info about a model, unwrapped the way JS returns it.

    Python's generated stub hands back the `{type, modelInfo}` envelope while
    JS returns the record itself, so a body reading `isCached` found nothing.
    """
    request = GetModelInfoRequest.model_validate({"type": "getModelInfo", **params})
    response = await get_model_info(transport, request)
    return _jsonable(response.model_info)


async def _vla_hparams(transport: Any, params: dict[str, Any]) -> Any:
    """The loaded VLA model's hyperparameters, named the way JS names them.

    Python returns a `(hparams, backend_name)` tuple; JS returns a record, and
    a catalog body projects `hparams` out of it.
    """
    hparams, backend_name = await vla_hparams(transport, model_id=params["modelId"])
    return {"hparams": _jsonable(hparams), "backendName": backend_name}


async def _download_asset(transport: Any, params: dict[str, Any]) -> Any:
    """Fetch an asset, taking a model constant the way the JS client does.

    `assetSrc` arrives as the descriptor the resource table resolved; the wire
    wants its `src` string, which is the same normalisation `load_model` does
    for `modelSrc`. JS binds `{ path }`, so this does too.
    """
    asset_src = params.get("assetSrc")
    request = DownloadAssetRequest.model_validate(
        {
            "type": "downloadAsset",
            **{**params, "assetSrc": model_src_to_wire(asset_src)},
        }
    )
    response = await download_asset(transport, request)
    envelope = response.model_dump(mode="json", by_alias=True)
    if envelope.get("success") is False:
        raise reconstruct_error(envelope)
    return {"path": envelope.get("assetId")}


#: Scratch directories this run made, so `producedFile` can only be asked
#: about one of them and nothing else on the machine.
_SCRATCH_DIRECTORIES: set[str] = set()


def _within_scratch(candidate: str) -> bool:
    """Is this path one of this run's scratch roots, or inside one?"""
    resolved = Path(candidate).resolve()
    for root in _SCRATCH_DIRECTORIES:
        root_path = Path(root).resolve()
        if resolved == root_path or root_path in resolved.parents:
            return True
    return False


def _within_scratch(candidate: str) -> bool:
    """Is this path one of this run's scratch roots, or inside one?"""
    resolved = Path(candidate).resolve()
    for root in _SCRATCH_DIRECTORIES:
        root_path = Path(root).resolve()
        if resolved == root_path or root_path in resolved.parents:
            return True
    return False


def _scratch(method: str, params: dict[str, Any]) -> dict[str, Any]:
    """The scratch-directory surface, kept in step with the JS bindings."""
    if method == "scratchDirectory":
        root = tempfile.mkdtemp(prefix="qvac-e2e-")
        directories: dict[str, str] = {}
        for name in params.get("subdirectories") or []:
            directories[name] = str(Path(root, name))
            Path(root, name).mkdir(parents=True, exist_ok=True)
        _SCRATCH_DIRECTORIES.add(root)
        # The subdirectory paths are handed back rather than joined in the
        # catalog: a step names data, and building a path out of two bound
        # values is not something it can do.
        return {"path": root, "directories": directories}
    if method == "producedFile":
        directory = str(params.get("directory"))
        if not _within_scratch(directory):
            raise StepError(
                f'"{directory}" is not inside a directory this test created'
            )
        target = Path(directory, str(params.get("file")))
        return {"exists": target.exists(), "path": str(target)}
    target_root = params.get("path")
    if not target_root or target_root not in _SCRATCH_DIRECTORIES:
        return {"discarded": False}
    _SCRATCH_DIRECTORIES.discard(target_root)
    shutil.rmtree(target_root, ignore_errors=True)
    return {"discarded": True}


async def _transcribe(transport: Any, params: dict[str, Any]) -> Any:
    """Transcribe, taking a file path or bytes the way the JS client does.

    The wire's `audioChunk` is a tagged union -- `{type: "filePath"}` or
    `{type: "base64"}` -- and JS normalises into it inside its own API layer
    (`buildTranscribeRequest`). Python's generated stub takes the union
    directly, so a catalog step that resolves an asset to a path handed it a
    bare string and the request failed validation before reaching the worker.

    Normalising here rather than in the generated module, which is generated;
    the asymmetry is worth closing with an ergonomic wrapper in the Python SDK,
    the way `_streams._image` already does for diffusion.
    """
    chunk = params.get("audioChunk")
    if isinstance(chunk, str):
        chunk = {"type": "filePath", "value": chunk}
    elif isinstance(chunk, (bytes, bytearray, memoryview)):
        chunk = {"type": "base64", "value": base64.b64encode(bytes(chunk)).decode()}
    # JS builds this request with `...(params.prompt && { prompt })` and
    # `...(params.metadata === true && { metadata: true })`, so a falsy prompt
    # is not a null on the wire -- the field is absent. Sending `prompt: null`
    # is refused by the worker's own schema, which is how
    # `transcription-without-prompt` failed here and passed there.
    payload = {**params, "audioChunk": chunk}
    if not payload.get("prompt"):
        payload.pop("prompt", None)
    if payload.get("metadata") is not True:
        payload.pop("metadata", None)
    request = TranscribeRequest.model_validate({"type": "transcribe", **payload})
    # The generated stub yields chunks; JS folds them into the complete text,
    # or into the segment list when `metadata` is set, and resolves one value.
    # Awaiting the generator raised TypeError, so transcription never ran from
    # Python -- the same fold has to live on this side of the wire.
    want_segments = bool(params.get("metadata"))
    segments: list[Any] = []
    text = ""
    async for response in transcribe(transport, request):
        if getattr(response, "segment", None) is not None:
            segments.append(_jsonable(response.segment))
        if getattr(response, "text", None):
            text += response.text
        if getattr(response, "done", False):
            break
    # Bound under the name that says what came back, exactly as JS binds it:
    # `metadata` returns segments, not a transcript, and a body projecting
    # `text` off one would be reading records under a string's name.
    return {"segments": segments} if want_segments else {"text": text}


async def _vector_index_dispose(transport: Any, params: dict[str, Any]) -> Any:
    """Close an index, tolerating one that was never opened.

    Teardown runs on the failure path too, and a body that failed before
    creating an index leaves `$indexId?` resolving to nothing -- the request
    would then fail validation and report a teardown failure for a test whose
    real problem was somewhere else. JS's binding guards the same way.
    """
    index_id = params.get("indexId")
    if not index_id:
        return {"disposed": False}
    request = VectorIndexRequest.model_validate(
        {"type": "vectorIndex", "operation": "dispose", "indexId": index_id}
    )
    response = await vector_index(transport, request)
    envelope = response.model_dump(mode="json", by_alias=True)
    if envelope.get("success") is False:
        raise reconstruct_error(envelope)
    return {"disposed": True}


async def _vector_index_search(transport: Any, params: dict[str, Any]) -> Any:
    """One query against an index, folded the way JS folds it.

    The wire takes a list of queries and answers a list of result lists. JS's
    handle unwraps the single-query case before the caller ever sees it, so
    the fold happens here too -- otherwise `$hits[0].id` would mean the first
    hit on one client and the first query's whole result list on the other.
    """
    request = VectorIndexRequest.model_validate(
        {
            "type": "vectorIndex",
            "operation": "search",
            "indexId": params["indexId"],
            "queries": [params["query"]],
            "k": params["k"],
        }
    )
    response = await vector_index(transport, request)
    envelope = response.model_dump(mode="json", by_alias=True)
    if envelope.get("success") is False:
        raise reconstruct_error(envelope)
    return {"results": (envelope.get("results") or [[]])[0]}


async def _bci_transcribe(transport: Any, params: dict[str, Any]) -> Any:
    """BCI transcription, with `neuralData` normalised into its wire union.

    Same asymmetry as `audioChunk` on `_transcribe`: the wire takes a tagged
    union -- `{type: "filePath"}` or `{type: "base64"}` -- JS normalises into
    it inside its own API layer, and the Python stub takes the union directly.
    A catalog step that resolved a fixture to a path therefore handed it a bare
    string and the request failed validation before reaching the worker.
    """
    data = params.get("neuralData")
    if isinstance(data, str):
        data = {"type": "filePath", "value": data}
    elif isinstance(data, (bytes, bytearray, memoryview)):
        data = {"type": "base64", "value": base64.b64encode(bytes(data)).decode()}
    request = BciTranscribeRequest.model_validate(
        {"type": "bciTranscribe", **{**params, "neuralData": data}}
    )
    text = ""
    async for response in bci_transcribe(transport, request):
        if getattr(response, "text", None):
            text += response.text
        if getattr(response, "done", False):
            break
    return {"text": text}


async def _classified(transport: Any, params: dict[str, Any]) -> Any:
    """Classification, bound the way JS binds it.

    JS wraps the result as `{ results }` so a later step has a field to project.
    The ergonomic wrapper owns the base64 encoding, as JS's client API does.
    """
    return {"results": await classify(transport, **_snake(params))}


def _request(
    model: Any, method: str, call: Callable[..., Any], **fixed: Any
) -> Callable[..., Any]:
    """Wrap a generated stub that takes a validated request model.

    `fixed` names the discriminator a request union needs but the catalog step
    does not carry -- `rag` is one wire method with nine operations, and the JS
    client picks the branch by which function the test called. Leaving it to
    the validator to guess would let a `deleteWorkspace` parse as some other
    member that happens to accept the same field.

    A generated stub hands back the wire envelope as it arrived, so a rejected
    call shows up as `success: false` rather than as an exception. Turning that
    into a raise is the binding's job, not the interpreter's: the JS client
    gets the same treatment from its SDK before the interpreter ever sees a
    value, and the interpreter has to mean the same thing on both clients or
    the comparison is worthless. The ergonomic wrappers raise already and do
    not go through here.
    """

    async def invoke(transport: Any, params: dict[str, Any]) -> Any:
        response = await call(
            transport, model.model_validate({"type": method, **fixed, **params})
        )
        envelope = (
            response.model_dump() if hasattr(response, "model_dump") else response
        )
        if isinstance(envelope, dict) and envelope.get("success") is False:
            # reconstruct_error, not a bare StepError: it rebuilds the typed
            # error the server threw, carrying the same numeric code the JS
            # client's SDK raises for the same refusal. A codeless exception
            # here would make `errorIsStructured` and `errorMatches` fail on
            # Python for a rejection that passes on JS -- drift manufactured by
            # the binding that exists to prevent it.
            raise reconstruct_error(envelope)
        return response

    return invoke


CALLS: dict[str, Callable[[Any, dict[str, Any]], Any]] = {
    # --- inference, request/reply -------------------------------------------
    "embed": _request(EmbedRequest, "embed", embed),
    "classify": lambda transport, params: _classified(transport, params),
    "transcribe": _transcribe,
    "bciTranscribe": _bci_transcribe,
    "vla": lambda transport, params: vla(transport, **_snake(params)),
    "vlaHparams": _vla_hparams,
    "vlaSetEmbodiment": lambda transport, params: vla_set_embodiment(
        transport, model_id=params["modelId"], embodiment=params["embodiment"]
    ),
    # --- models --------------------------------------------------------------
    "loadModel": lambda transport, params: _load_model(transport, params),
    "unloadModel": lambda transport, params: unload_model(
        transport, model_id=params["modelId"]
    ),
    "getModelInfo": _get_model_info,
    "getLoadedModelInfo": _request(
        GetLoadedModelInfoRequest, "getLoadedModelInfo", get_loaded_model_info
    ),
    # --- registry ------------------------------------------------------------
    "modelRegistryList": lambda transport, params: model_registry_list(transport),
    "modelRegistrySearch": lambda transport, params: model_registry_search(
        transport,
        filter=params.get("filter"),
        engine=params.get("engine"),
        quantization=params.get("quantization"),
        addon=params.get("addon"),
        model_type=params.get("modelType"),
    ),
    "modelRegistryGetModel": lambda transport, params: model_registry_get_model(
        transport, params["registryPath"], params["registrySource"]
    ),
    # --- runtime and host ----------------------------------------------------
    # An ergonomic wrapper, so keyword arguments -- `_request` passes a
    # validated request model positionally, which is the raw stub's convention
    # and a TypeError here.
    "cancel": lambda transport, params: cancel(
        transport,
        request_id=params.get("requestId"),
        model_id=params.get("modelId"),
        kind=params.get("kind"),
        clear_cache=params.get("clearCache"),
    ),
    "deleteCache": lambda transport, params: delete_cache(
        transport,
        all=params.get("all"),
        auto=params.get("auto"),
        kv_cache_key=params.get("kvCacheKey"),
        model_id=params.get("modelId"),
    ),
    "downloadAsset": _download_asset,
    "getSystemResources": _request(
        GetSystemResourcesRequest, "getSystemResources", get_system_resources
    ),
    "heartbeat": _request(HeartbeatRequest, "heartbeat", heartbeat),
    "suspend": _request(SuspendRequest, "suspend", suspend),
    "resume": _request(ResumeRequest, "resume", resume),
    "state": _request(StateRequest, "state", state),
    # --- rag, vector index, finetune -----------------------------------------
    "ragIngest": _request(RagRequest, "rag", rag, operation="ingest"),
    "ragCloseWorkspace": _request(RagRequest, "rag", rag, operation="closeWorkspace"),
    "ragDeleteWorkspace": _request(RagRequest, "rag", rag, operation="deleteWorkspace"),
    "createVectorIndex": _request(
        VectorIndexRequest, "vectorIndex", vector_index, operation="create"
    ),
    "loadVectorIndex": _request(
        VectorIndexRequest, "vectorIndex", vector_index, operation="load"
    ),
    # The vector index is a handle API in JS -- an object with methods on it,
    # keyed by the id the worker assigned. The wire protocol keys on that id
    # too, which is what lets the same catalog body run here without a handle
    # wrapper: every operation is one request naming the index.
    "vectorIndexAdd": _request(
        VectorIndexRequest, "vectorIndex", vector_index, operation="add"
    ),
    "vectorIndexRemove": _request(
        VectorIndexRequest, "vectorIndex", vector_index, operation="remove"
    ),
    "vectorIndexContains": _request(
        VectorIndexRequest, "vectorIndex", vector_index, operation="contains"
    ),
    "vectorIndexWrite": _request(
        VectorIndexRequest, "vectorIndex", vector_index, operation="write"
    ),
    "vectorIndexDispose": _vector_index_dispose,
    "vectorIndexSearch": _vector_index_search,
    # --- transcription sessions ---------------------------------------------
    #
    # `transcribe_stream_session` is a duplex session: open it, write audio,
    # end the input, then read events off it. A step can only name a method and
    # pass data, so the session stays in a registry here and the catalog
    # addresses it by the id handed out -- the same shape the vector index
    # takes, for the same reason.
    "transcribeStreamOpen": _transcribe_stream_open,
    "transcribeStreamWrite": _transcribe_stream_write,
    "transcribeStreamWriteChunks": _transcribe_stream_write_chunks,
    "loggingStreamOpen": _logging_stream_open,
    "loggingStreamMark": _logging_stream_mark,
    "loggingStreamCollect": _logging_stream_collect,
    "loggingStreamClose": _logging_stream_close,
    "bciTranscribeStreamOpen": _bci_transcribe_stream_open,
    "transcribeStreamWriteBytes": _transcribe_stream_write_bytes,
    "transcribeStreamEnd": _transcribe_stream_end,
    "transcribeStreamDestroy": _transcribe_stream_destroy,
    # --- the harness's own surface ------------------------------------------
    #
    # Not an SDK call: a reload test has to put the model back where the
    # resource manager can find it, and unloading the id directly would leave
    # the manager handing out an id the worker no longer knows.
    # --- plugins -------------------------------------------------------------
    # JS binds `{ result }` so a later step has a field to project; matching
    # that here keeps one definition working on both clients.
    "invokePlugin": _invoke_plugin,
}


def _snake(params: dict[str, Any]) -> dict[str, Any]:
    """camelCase step params -> the snake_case keyword arguments Python uses."""
    out: dict[str, Any] = {}
    for key, value in params.items():
        out[re.sub(r"(?<!^)(?=[A-Z])", "_", key).lower()] = value
    return out


def _load_model(transport: Any, params: dict[str, Any]) -> Any:
    """Loads a model, and optionally records what the loader reported.

    `withProgress` is how a step asks for the `on_progress` callback a catalog
    cannot pass: the events are collected here and handed back as data. It is
    the only way to tell a cache hit from a re-download from outside -- a hit
    reports at most a final 100% per file, a real download reports partials.
    """

    async def run() -> dict[str, Any]:
        progress: list[Any] = []
        want_progress = bool(params.get("withProgress"))
        model_id = await load_model(
            transport,
            model_src=params.get("modelSrc"),
            model_type=params.get("modelType"),
            model_config=params.get("modelConfig"),
            model_name=params.get("modelName"),
            model_id=params.get("modelId"),
            on_progress=(lambda event: progress.append(_jsonable(event)))
            if want_progress
            else None,
        )
        # JS binds `{ modelId }` so a later step can project it; matching that
        # here keeps one definition working on both clients.
        if want_progress:
            return {"modelId": model_id, "progress": progress}
        return {"modelId": model_id}

    return run()


async def _completion_stream(
    transport: Any, params: dict[str, Any], collect: str
) -> Any:
    """Fold a completion the way `collect` asks for.

    The fold is the interesting half of a streaming binding: two clients are
    only running the same test if "the text of this completion" means the same
    thing on both. Kept beside the JS fold in `tests/shared/step-bindings.ts`
    so a divergence is a one-line diff rather than an archaeology exercise.
    """
    run = completion(
        transport,
        model_id=params["modelId"],
        history=params["history"],
        stream=params.get("stream", True),
        generation_params=params.get("generationParams"),
        tools=params.get("tools"),
        response_format=params.get("responseFormat"),
        tool_dialect=params.get("toolDialect"),
        # `kv_cache` was missing, so every kv-cache test ran against this
        # client with no cache at all -- and the ones that only check that text
        # came back passed anyway. `cacheTokens` stayed zero, which is what
        # finally showed it.
        kv_cache=params.get("kvCache"),
        capture_thinking=params.get("captureThinking"),
        emit_raw_deltas=params.get("emitRawDeltas"),
    )
    if collect == "text":
        # `tool_calls` rides along with the text because a tools test needs
        # both: the model either answered or called a tool, and which one it
        # did is the question. Two folds would mean two completions. `stats`
        # and `stop_reason` ride along for the same reason.
        calls = await run.tool_calls()
        final = await run.final
        return {
            "text": await run.text(),
            "toolCalls": [
                {"name": call.name, "arguments": call.arguments} for call in calls
            ],
            "stats": _jsonable(final.stats),
            "stopReason": final.stop_reason,
            "fullText": final.raw_full_text,
        }
    if collect == "events":
        return {"events": [_jsonable(event) async for event in run.events]}
    raise StepError(
        f'collect: "{collect}" is not defined for completion', incomplete=True
    )


async def _translate_stream(
    transport: Any, params: dict[str, Any], collect: str
) -> Any:
    if collect not in ("text", "all"):
        raise StepError(
            f'collect: "{collect}" is not defined for translate', incomplete=True
        )
    stream = params.get("stream", True)
    run = translate(
        transport,
        model_id=params["modelId"],
        text=params["text"],
        model_type=params["modelType"],
        to=params.get("to"),
        from_=params.get("from"),
        stream=stream,
        context=params.get("context"),
    )
    if collect == "all":
        # `all` carries the joined text beside the tokens: "it streamed, and
        # this is what it said" is one question, and a second fold would be a
        # second translation.
        tokens = [token async for token in run.token_stream]
        return {
            "all": tokens,
            "text": "".join(tokens),
            "stats": _jsonable(await run.stats),
        }
    if not stream:
        # `translations` rides along: a batch asks about the entries and about
        # the text they join to, and a second fold would be a second
        # translation.
        return {
            "text": await run.text,
            "translations": await run.translations,
            "stats": _jsonable(await run.stats),
        }
    # `text` resolves to the empty string in streaming mode on both clients, so
    # the fold has to follow the mode rather than always await the same handle.
    text = ""
    async for token in run.token_stream:
        text += token
    return {"text": text, "stats": _jsonable(await run.stats)}


async def _ocr_stream(transport: Any, params: dict[str, Any], collect: str) -> Any:
    run = ocr(
        transport,
        model_id=params["modelId"],
        image=params["image"],
        options=params.get("options"),
    )
    # `blocks` resolves empty in streaming mode, the same trap `translate` has:
    # the fold follows the call's own mode rather than always awaiting the same
    # handle.
    if params.get("stream"):
        batches = [batch async for batch in run.block_stream]
        blocks = [block for batch in batches for block in batch]
    else:
        blocks = await run.blocks

    # `stats` rides along with every fold: a test that checks timing asks for
    # it from the same run, and a second call would time a different one.
    stats = _jsonable(await run.stats)

    if collect == "blocks":
        return {"blocks": _jsonable(blocks), "stats": stats}
    if collect in ("all", "events"):
        folded = _jsonable(blocks)
        return {"all": folded, "events": folded, "stats": stats}
    if collect == "text":
        # Space, not newline: this is what the executors joined with, and a
        # migrated test has to reproduce what its executor produced.
        return {
            "text": " ".join(getattr(b, "text", "") or "" for b in blocks),
            "stats": stats,
        }
    raise StepError(f'collect: "{collect}" is not defined for ocr', incomplete=True)


async def _transcribe_stream(
    transport: Any, params: dict[str, Any], collect: str
) -> Any:
    run = transcribe_stream_run(
        transport,
        model_id=params["modelId"],
        **{k: v for k, v in params.items() if k not in ("modelId",)},
    )
    pieces = await run.collected
    if collect in ("blocks", "all"):
        return {collect: _jsonable(pieces)}
    if collect == "last":
        return {"last": _jsonable(pieces[-1]) if pieces else None}
    if collect == "text":
        return {"text": "".join(str(p) for p in pieces)}
    raise StepError(
        f'collect: "{collect}" is not defined for transcribeStream', incomplete=True
    )


async def _tts_stream(transport: Any, params: dict[str, Any], collect: str) -> Any:
    run = text_to_speech(
        transport,
        model_id=params["modelId"],
        **{k: v for k, v in params.items() if k != "modelId"},
    )
    if collect == "pcm":
        # The fold has to follow the mode. In streaming mode the run starts
        # lazily -- nothing is sent until the buffer stream is iterated -- so
        # awaiting `buffer` first leaves `sample_rate` and `done` pending for
        # ever and the test dies on its timeout rather than failing. The
        # non-streaming mode is the mirror image: there the stream is empty and
        # `buffer` is where the audio is. Mirrors the JS fold.
        if params.get("stream") is False:
            buffer = await run.buffer
        else:
            buffer = [sample async for sample in run.buffer_stream]
        return {
            "pcm": buffer,
            "sampleRate": await run.sample_rate,
            "done": await run.done,
        }
    if collect == "all":
        return {"all": [sample async for sample in run.buffer_stream]}
    if collect == "events":
        return {"events": [tick async for tick in run.progress_stream]}
    raise StepError(
        f'collect: "{collect}" is not defined for textToSpeech', incomplete=True
    )


async def _images_stream(run: Any, collect: str, method: str) -> Any:
    """diffusion and upscale return the same run shape, so they fold alike.

    Every fold carries the stats and the progress ticks beside the images: one
    generation is minutes of work, and a test that asked "did it report phase
    timings" with a second `collect` would be paying that twice to ask about
    the first run.
    """
    if collect not in ("events", "all", "last"):
        raise StepError(
            f'collect: "{collect}" is not defined for {method}', incomplete=True
        )
    # Progress is drained first because the generator is the live side of the
    # same stream; awaiting the outputs first would leave nothing to iterate.
    # `gather` rather than sequential awaits, so a run that fails does not
    # leave the second result unretrieved.
    # `upscale` reports no progress, so an absent stream folds to an empty
    # list rather than a fake tick -- which is the truth about that run.
    progress = getattr(run, "progress_stream", None)
    events, outputs, stats = await asyncio.gather(
        _drain(progress) if progress is not None else _nothing(),
        run.outputs,
        run.stats,
    )
    stats = _jsonable(stats)
    events = _jsonable(events)
    if collect == "events":
        return {"events": events, "all": outputs, "stats": stats}
    if collect == "last":
        return {
            "last": outputs[-1] if outputs else None,
            "events": events,
            "stats": stats,
        }
    return {"all": outputs, "events": events, "stats": stats}


async def _diffusion_stream(
    transport: Any, params: dict[str, Any], collect: str
) -> Any:
    run = diffusion(
        transport,
        model_id=params["modelId"],
        **{k: v for k, v in params.items() if k != "modelId"},
    )
    return await _images_stream(run, collect, "diffusion")


async def _upscale_stream(transport: Any, params: dict[str, Any], collect: str) -> Any:
    run = upscale(
        transport,
        model_id=params["modelId"],
        image=params["image"],
        repeats=params.get("repeats"),
    )
    return await _images_stream(run, collect, "upscale")


async def _nothing() -> list[Any]:
    """An empty result, for a handle that has no stream to drain."""
    return []


async def _drain(stream: Any) -> list[Any]:
    """Collect an async iterable, the way JS's `drain()` does."""
    return [item async for item in stream]


async def _audio_stream(run: Any, collect: str, method: str) -> Any:
    if collect == "pcm":
        # Progress is drained alongside the audio rather than in a second fold:
        # these tests ask whether one run produced audio *and* reported
        # progress, and a second `collect` would be a second generation.
        audio, raw_stats, progress = await asyncio.gather(
            run.audio, run.stats, _drain(run.progress_stream)
        )
        stats = _jsonable(raw_stats)
        # `data` here, `pcm` in JS. Renamed so `$run.audio.pcm` is one thing in
        # both clients rather than two spellings of the same bytes.
        return {
            "audio": {
                "pcm": audio["data"],
                "sampleRate": audio["sampleRate"],
                "channels": audio["channels"],
                "bitsPerSample": audio["bitsPerSample"],
            },
            "stats": stats,
            "events": progress,
        }
    if collect == "events":
        events = [tick async for tick in run.progress_stream]
        await run.audio
        return {"events": events}
    raise StepError(
        f'collect: "{collect}" is not defined for {method}', incomplete=True
    )


async def _audio_gen_stream(
    transport: Any, params: dict[str, Any], collect: str
) -> Any:
    run = audio_gen(
        transport,
        model_id=params["modelId"],
        **{k: v for k, v in params.items() if k != "modelId"},
    )
    return await _audio_stream(run, collect, "audioGen")


async def _audio_edit_stream(
    transport: Any, params: dict[str, Any], collect: str
) -> Any:
    run = audio_edit(
        transport,
        model_id=params["modelId"],
        operations=params["operations"],
        **{k: v for k, v in params.items() if k not in ("modelId", "operations")},
    )
    return await _audio_stream(run, collect, "audioEdit")


async def _audio_understand_stream(
    transport: Any, params: dict[str, Any], collect: str
) -> Any:
    run = audio_understand(
        transport,
        model_id=params["modelId"],
        **{k: v for k, v in params.items() if k != "modelId"},
    )
    if collect == "text":
        return {"text": await run.description}
    if collect == "events":
        events = [tick async for tick in run.progress_stream]
        await run.description
        return {"events": events}
    raise StepError(
        f'collect: "{collect}" is not defined for audioUnderstand', incomplete=True
    )


async def _finetune_stream(transport: Any, params: dict[str, Any], collect: str) -> Any:
    """Finetune, folded the way JS folds it.

    A control operation -- pause, resume, stop -- is a plain call that
    resolves and emits no progress. Folding one as though it had a `result`
    would await nothing, which resolves, so a refusal would read as success.
    """
    if params.get("operation"):
        request = FinetuneRequest.model_validate({"type": "finetune", **params})
        return {"last": _jsonable(await finetune(transport, request))}

    run = finetune_run(transport, **_snake(params))
    if collect == "events":
        events = [_jsonable(tick) async for tick in run.progress_stream]
        return {"events": events, "last": _jsonable(await run.result)}
    if collect == "last":
        return {"last": _jsonable(await run.result)}
    raise StepError(f'collect: "{collect}" is not defined for finetune', incomplete=True)


async def _batch_completion_stream(
    transport: Any, params: dict[str, Any], collect: str
) -> Any:
    run = batch_completion(
        transport,
        model_id=params["modelId"],
        prompts=params["prompts"],
        **{k: v for k, v in params.items() if k not in ("modelId", "prompts")},
    )
    if collect == "all":
        # Events are drained alongside the results: a streaming batch test asks
        # whether every prompt produced deltas *and* whether its final agrees
        # with them, and a second fold would be a second batch.
        # One `gather`, not two awaits in a row: an empty batch rejects both,
        # and a rejection awaited second is left unretrieved when the first one
        # raises. Mirrors the JS fold.
        results, events = await asyncio.gather(run.results, _drain(run.events))
        return {"all": _jsonable(results), "events": _jsonable(events)}
    if collect == "events":
        return {"events": _jsonable([event async for event in run.events])}
    raise StepError(
        f'collect: "{collect}" is not defined for batchCompletion', incomplete=True
    )


async def _world_step_stream(
    transport: Any, params: dict[str, Any], collect: str
) -> Any:
    run = world_step(transport, model_id=params["modelId"], keys=params.get("keys"))
    if collect == "all":
        return {"all": await run.frames}
    if collect == "last":
        frames = await run.frames
        return {"last": frames[-1] if frames else None, "frameCount": len(frames)}
    if collect == "events":
        frames = await run.frames
        return {
            "events": [tick async for tick in run.progress_stream],
            "frameCount": len(frames),
        }
    raise StepError(
        f'collect: "{collect}" is not defined for worldStep', incomplete=True
    )


async def _plugin_stream(transport: Any, params: dict[str, Any], collect: str) -> Any:
    chunks = [
        chunk
        async for chunk in invoke_plugin_stream(
            transport,
            model_id=params["modelId"],
            handler=params["handler"],
            params=params.get("params"),
        )
    ]
    if collect == "all":
        return {"all": _jsonable(chunks)}
    if collect == "last":
        return {"last": _jsonable(chunks[-1]) if chunks else None}
    if collect == "text":
        return {"text": "".join(str(c) for c in chunks)}
    raise StepError(
        f'collect: "{collect}" is not defined for invokePluginStream', incomplete=True
    )


# Methods whose result is a stream handle rather than a value. A step reaches
# these through `collect`, which names the fold it wants.
#
# Only the methods for which the Python SDK ships a *run handle* are here. The
# generated `<name>_stream` stubs exist for the rest, but they yield raw wire
# chunks: folding those in this client would mean writing the SDK's ergonomics
# inside the test client, and the test would then pass while the SDK still had
# no wrapper. That is the one thing this whole exercise is meant to prevent, so
# those methods report `incomplete` with the reason instead -- see
# NO_RUN_HANDLE.
STREAMS: dict[str, Callable[[Any, dict[str, Any], str], Any]] = {
    "completion": _completion_stream,
    "translate": _translate_stream,
    "ocr": _ocr_stream,
    "transcribeStream": _transcribe_stream,
    "textToSpeech": _tts_stream,
    "diffusion": _diffusion_stream,
    "upscale": _upscale_stream,
    "audioGen": _audio_gen_stream,
    "audioEdit": _audio_edit_stream,
    "audioUnderstand": _audio_understand_stream,
    "batchCompletion": _batch_completion_stream,
    "finetune": _finetune_stream,
    "worldStep": _world_step_stream,
    "invokePluginStream": _plugin_stream,
    "transcribeStreamDrain": _transcribe_stream_drain,
}

# Streaming methods the Python SDK still has no run handle for.
#
# This table is the client's own roadmap, and shrinking it is the number the
# release claim is about. Each entry says what JS returns, because that is the
# shape a definition written against the reference client assumes.
NO_RUN_HANDLE: dict[str, str] = {}

# Methods whose Python surface is NOT yet the ergonomic equivalent of the JS
# one. The generated stub exists and the wire contract matches, but the shape
# the caller gets differs — so a definition written against the JS shape cannot
# run here yet.
#
# This is the same family as the missing stream folds: the typed surface is
# generated, the behaviour above it is hand-written per client, and that is
# exactly where a release claim needs evidence. Found by migrating a second
# category, which is what migrating one is for.
NOT_YET_ERGONOMIC: dict[str, str] = {
    "getLoadedModelInfo": (
        "Python's get_loaded_model_info returns the raw {type, info} envelope; "
        "the JS client returns info directly. Needs an ergonomic wrapper before "
        "a definition written against the JS shape can run here."
    ),
}

_INDEX = re.compile(r"^(.*?)\[(\d+)\]$")

#: `field[*]` -- the rest of the path applied to every element. The path syntax
#: advertised this all along (`blocks[*].text`) while neither walker understood
#: it, so a body that used it failed with `has no "blocks[*]"`.
_WILDCARD = re.compile(r"^(.*?)\[\*\]$")


class _Missing:
    """An optional reference that resolved to nothing.

    Distinct from None so a step can still pass an explicit null where the
    contract has one.
    """

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "<missing>"


_MISSING = _Missing()


class StepError(Exception):
    """A step could not run. Carries whether that is a failure or a gap."""

    def __init__(self, message: str, incomplete: bool = False) -> None:
        super().__init__(message)
        self.incomplete = incomplete


#: A fixture the catalog names but no file holds: "2s-440hz" is two seconds of
#: a 440 Hz tone. The audio tests feed a synthesized tone rather than a
#: recording because the point is a known signal, not a performance.
_TONE = re.compile(r"^(\d+(?:\.\d+)?)s-(\d+(?:\.\d+)?)hz$")

#: The input format AudioGen accepts: interleaved stereo 48 kHz Float32 LE PCM.
_TONE_SAMPLE_RATE = 48000
_TONE_CHANNELS = 2


def _synthesize_bytes(spec: str) -> bytes:
    """A fixture spelled out in hex: "00010203" is four bytes.

    For the deliberately malformed inputs -- four bytes that cannot be a JPEG,
    a truncated header. Checking such a file in would hide what makes it
    invalid behind a binary; written in the catalog, the test says it.
    """
    try:
        return bytes.fromhex(spec)
    except ValueError as error:
        raise StepError(f'bytes "{spec}" is not an even-length hex string') from error


def _synthesize_tone(spec: str) -> bytes:
    """Raw interleaved stereo 48 kHz Float32 LE PCM for a named tone.

    Kept beside the JS synthesizer in `tests/shared/step-bindings.ts`: "the
    same source audio" only means something if both clients build the same
    bytes from the same name.
    """
    match = _TONE.match(spec)
    if match is None:
        raise StepError(f'tone "{spec}" is not "<seconds>s-<frequency>hz"')
    seconds, frequency = float(match.group(1)), float(match.group(2))
    frames = round(_TONE_SAMPLE_RATE * seconds)
    pcm = array("f")
    for frame in range(frames):
        sample = 0.1 * math.sin(2 * math.pi * frequency * frame / _TONE_SAMPLE_RATE)
        for _ in range(_TONE_CHANNELS):
            pcm.append(sample)
    if sys.byteorder != "little":
        pcm.byteswap()
    return pcm.tobytes()


@dataclass
class _Pending:
    """A call `start` began and `settle` has yet to await.

    Wrapped in a class rather than left as a bare task so a started call cannot
    be mistaken for data: every other binding in scope is a value the test may
    project or assert on.
    """

    task: asyncio.Future


#: Where the run collects started calls, so none outlive the test.
_STARTED = "__started"

#: How long `start` lets the loop run before the next step. Long enough for the
#: request to leave, short enough to be noise against any test that races one.
_START_ON_WIRE_S = 0.05


class Interpreter:
    def __init__(self, resources: ResourceManager, log) -> None:
        self._resources = resources
        self._log = log

    async def run(
        self,
        steps: list[dict[str, Any]],
        params: dict[str, Any],
        expectation: dict[str, Any],
        teardown: list[dict[str, Any]] | None = None,
    ) -> StepResult:
        teardown = teardown or []
        # Evict anything this test did not declare before it starts, so a run
        # does not depend on the order tests happened to arrive in. Teardown
        # counts as declaration: a test that unloads its model in `finally`
        # must not have it evicted out from under the body.
        declared = {
            dep
            for step in [*steps, *teardown]
            if "useModel" in step
            for dep in step["useModel"].get("deps", [])
        }
        await self._resources.evict_all_except(declared)

        scope: dict[str, Any] = {"params": params}

        body = await self._run_body(steps, scope, expectation)
        failed_teardown = await self._run_teardown(teardown, scope, expectation)
        await self._drain_started(scope)
        if failed_teardown is None:
            return body
        # A body that passed cannot be claimed on a client that could not clean
        # up after it, so the teardown's verdict stands. A body that already
        # failed keeps its own message -- that is the diagnosis -- and carries
        # the teardown failure alongside it. Mirrors the JS interpreter.
        if body.passed:
            return failed_teardown
        return replace(
            body,
            output=f"{body.output} [teardown also failed: {failed_teardown.output}]",
        )

    async def _run_body(
        self,
        steps: list[dict[str, Any]],
        scope: dict[str, Any],
        expectation: dict[str, Any],
    ) -> StepResult:
        try:
            last_assert = await self._run_steps(steps, scope, expectation)
        except StepError as error:
            if error.incomplete:
                return StepResult.incomplete(str(error))
            return StepResult.fail(str(error))
        except Exception as error:  # noqa: BLE001 - any client error fails the test
            return StepResult.fail(f"{type(error).__name__}: {error}")

        if last_assert is None:
            return StepResult.fail("test body ran but asserted nothing")
        return last_assert

    async def _run_teardown(
        self,
        steps: list[dict[str, Any]],
        scope: dict[str, Any],
        expectation: dict[str, Any],
    ) -> StepResult | None:
        """Runs the teardown steps, returning only a failure.

        Teardown runs on both paths, so a body that fails halfway still
        restores the client. It shares the body scope: teardown usually needs
        what the body bound, and a binding the body never reached is referenced
        optionally.
        """
        if not steps:
            return None
        try:
            # Teardown that asserts nothing is clean -- `resume()` is a
            # restoration, not a claim, so `_run_body`'s "asserted nothing"
            # rule must not apply here.
            result = await self._run_steps(steps, scope, expectation)
        except StepError as error:
            result = (
                StepResult.incomplete(str(error))
                if error.incomplete
                else StepResult.fail(str(error))
            )
        except Exception as error:  # noqa: BLE001 - any client error fails the test
            result = StepResult.fail(f"{type(error).__name__}: {error}")
        return None if result is None or result.passed else result

    async def _run_steps(
        self,
        steps: list[dict[str, Any]],
        scope: dict[str, Any],
        expectation: dict[str, Any],
    ) -> StepResult | None:
        last_assert: StepResult | None = None
        for step in steps:
            result = await self._run_step(step, scope, expectation)
            if result is None:
                continue
            # The first failing check decides the test. A migrated executor
            # often becomes several checks in a row -- shape, then length, then
            # value -- and without this a later passing one would mask an
            # earlier failure. Mirrors the JS interpreter.
            if not result.passed:
                return result
            last_assert = result
        return last_assert

    async def _run_step(
        self,
        step: dict[str, Any],
        scope: dict[str, Any],
        expectation: dict[str, Any],
    ) -> StepResult | None:
        if len(step) != 1:
            raise StepError(
                f"a step must carry exactly one operation, got {sorted(step)}"
            )
        op, body = next(iter(step.items()))

        if op == "useModel":
            return await self._use_model(body, scope)
        if op == "modelSource":
            return self._model_source(body, scope)
        if op == "asset":
            return self._asset(body, scope)
        if op == "call":
            return await self._call(body, scope)
        if op == "start":
            return await self._start(body, scope)
        if op == "settle":
            return await self._settle(body, scope)
        if op == "callError":
            return await self._call_error(body, scope)
        if op == "repeat":
            return await self._repeat(body, scope, expectation)
        if op == "project":
            return self._project(body, scope)
        if op == "assert":
            return self._assert(body, scope, expectation)
        if op == "compare":
            return self._compare(body, scope)

        raise StepError(
            f'step operation "{op}" is not implemented by the Python interpreter yet',
            incomplete=True,
        )

    def _compare(self, body: dict[str, Any], scope: dict[str, Any]) -> StepResult:
        """Check two bound values against each other.

        Distinct from `assert` because the question is about the relationship:
        the same call made twice with one parameter changed, and the claim is
        that the results differ -- or do not.
        """
        named = body["named"]
        comparison = COMPARISONS.get(named)
        if comparison is None:
            raise StepError(
                f'named comparison "{named}" is not in the Python registry',
                incomplete=True,
            )
        left = self._resolve(body["left"], scope)
        right = self._resolve(body["right"], scope)
        args = self._resolve(body.get("with") or {}, scope)
        return comparison(left, right, args)

    async def _call_error(self, body: dict[str, Any], scope: dict[str, Any]) -> None:
        """A call expected to fail. Binds { code, message }.

        If the call succeeds the test fails: an error test that quietly passes
        when the error stops happening is worse than no test.
        """
        method = body["method"]
        call = CALLS.get(method)
        collect = body.get("collect")
        if call is None and not collect:
            raise StepError(
                f'SDK method "{method}" is not wired into the Python interpreter yet',
                incomplete=True,
            )

        params = self._call_params(body.get("params"), scope)

        self._log(f"callError {method}")
        try:
            await self._invoke(method, call, params, collect)
        except StepError:
            # Every StepError reaching here is a binding GAP -- an unwired
            # method, a fold this client has no run handle for. "This client
            # cannot do that yet" is not the rejection the test is waiting for,
            # and binding it as one would report a passing error test for
            # something the client never ran. A real refusal arrives as the
            # SDK's own typed error and is handled below, exactly as on JS.
            raise
        except Exception as error:  # noqa: BLE001 - the rejection is the subject
            code = getattr(error, "code", None)
            # `hasCause` and a present `code` are what an "errors are
            # structured" test asks about. Binding them here keeps that
            # question answerable without a step that reaches into a
            # language's exception object.
            scope[body["as"]] = {
                "code": "" if code is None else str(code),
                "message": str(error),
                "hasCause": error.__cause__ is not None,
                # The typed errors carry data of their own -- the prompt size
                # and window a context overflow was measured against, say. A
                # test that could only read the message would be asserting on
                # prose; these are the numbers it actually wants.
                "details": _error_details(error),
            }
            return None

        raise StepError(f"{method} was expected to fail but resolved")

    async def _invoke(
        self,
        method: str,
        call: Callable[[Any, dict[str, Any]], Any] | None,
        params: dict[str, Any],
        collect: str | None,
    ) -> Any:
        """One call, folded if the step asked for a fold."""
        if collect:
            stream = STREAMS.get(method)
            if stream is None:
                raise StepError(
                    NO_RUN_HANDLE.get(method)
                    or f'SDK method "{method}" has no stream fold in the Python '
                    "interpreter yet",
                    incomplete=True,
                )
            return await stream(self._resources.transport, params, collect)
        if call is None:
            raise StepError(
                f'SDK method "{method}" is not wired into the Python interpreter yet',
                incomplete=True,
            )
        return await call(self._resources.transport, params)

    async def _repeat(
        self,
        body: dict[str, Any],
        scope: dict[str, Any],
        expectation: dict[str, Any],
    ) -> None:
        items = self._resolve(body["over"], scope)
        if not isinstance(items, list):
            raise StepError(f'repeat.over "{body["over"]}" did not resolve to a list')

        steps: list[dict[str, Any]] = body["steps"]
        collected: list[Any] = []
        for item in items:
            # Each iteration gets its own scope so a binding from one item
            # cannot leak into the next.
            inner = {**scope, body["as"]: item}
            failure = await self._run_steps(steps, inner, expectation)
            if failure is not None and not failure.passed:
                # An iteration that failed its own check must stop the repeat
                # rather than contribute a half-built value to `collectInto`.
                raise StepError(
                    failure.output or "repeat iteration failed",
                    incomplete=failure.is_incomplete,
                )
            collected.append(inner.get(_last_binding(steps) or "result"))

        scope[body["collectInto"]] = collected
        return None

    # Asset family -> the directory it lives in, mirroring ASSET_ROOTS in
    # tests/shared/step-bindings.ts. Two clients only run the same test if
    # `{ kind: "image", file: "elephant.jpg" }` means the same file on both.
    ASSET_ROOTS = {
        "image": "images",
        "audio": "audio",
        "document": "documents",
        "neural": "neural",
    }

    def _asset(self, body: dict[str, Any], scope: dict[str, Any]) -> None:
        """Resolve a bundled fixture: its bytes, or a path the SDK can open."""
        # `kind` and `file` resolve like any other value: a category whose
        # tests differ only in which fixture they use should carry one body and
        # name the file in its params.
        kind = str(self._resolve(body["kind"], scope))
        if kind == "bytes":
            if body.get("form") == "path":
                raise StepError("synthesized bytes have no path")
            scope[body["as"]] = _synthesize_bytes(
                str(self._resolve(body["file"], scope))
            )
            return None
        if kind == "tone":
            if body.get("form") == "path":
                raise StepError("a synthesized tone has no path")
            scope[body["as"]] = _synthesize_tone(
                str(self._resolve(body["file"], scope))
            )
            return None
        root = self.ASSET_ROOTS.get(kind)
        if root is None:
            raise StepError(
                f'asset kind "{kind}" is not known to the Python client',
                incomplete=True,
            )
        base = (ASSET_ROOT / root).resolve()
        absolute = (base / str(self._resolve(body["file"], scope))).resolve()
        # The asset name arrives from the catalog, and with form="path" it is
        # handed straight to the SDK. A definition is data that travels, so a
        # name that climbs out of the asset root is refused here rather than
        # trusted because today's catalog happens to contain only literals.
        if base != absolute and base not in absolute.parents:
            raise StepError(
                f'asset "{body["file"]}" resolves outside the "{kind}" asset root'
            )
        if not absolute.exists():
            # A missing fixture is a real failure, not a client gap.
            raise StepError(f"asset not found: {absolute}")
        form = body.get("form")
        if form == "path":
            scope[body["as"]] = str(absolute)
        elif form == "text":
            scope[body["as"]] = absolute.read_text(encoding="utf-8")
        else:
            scope[body["as"]] = absolute.read_bytes()
        return None

    def _model_source(self, body: dict[str, Any], scope: dict[str, Any]) -> None:
        """The model source behind a resource key, without loading it."""
        try:
            scope[body["as"]] = self._resources.source_of(
                str(self._resolve(body["dep"], scope))
            )
        except UnknownResourceError as error:
            raise StepError(str(error), incomplete=True) from error
        return None

    async def _use_model(self, body: dict[str, Any], scope: dict[str, Any]) -> None:
        deps: list[str] = body["deps"]
        try:
            model_ids = [await self._resources.ensure_loaded(dep) for dep in deps]
        except UnknownResourceError as error:
            raise StepError(str(error), incomplete=True) from error

        name = body.get("as")
        if name:
            # One key binds the id itself; several bind the list, so a step can
            # address them positionally.
            scope[name] = model_ids[0] if len(model_ids) == 1 else model_ids
        # Convention: the first declared model is addressable as $model so the
        # common single-model test needs no explicit `as`.
        scope.setdefault("model", model_ids[0])
        return None

    async def _call_value(self, body: dict[str, Any], scope: dict[str, Any]) -> Any:
        """Performs one call and returns its value, without binding it.

        Shared by `call`, which binds the value, and `start`, which hands the
        coroutine to a task instead.
        """
        method = body["method"]
        # Not an SDK call, and deliberately not in CALLS: a reload test has to
        # put the model back where the resource manager can find it, and
        # unloading the id directly would leave the manager handing out an id
        # the worker no longer knows. The manager belongs to the interpreter,
        # so this is the one method dispatched from here.
        if method == "evictResource":
            evicted = self._call_params(body.get("params"), scope)
            await self._resources.evict(str(evicted["dep"]))
            return {"evicted": True}
        # A fresh directory the test may write into, and a look at what landed
        # there. Platform facts, not SDK calls, which is why they are handled
        # here rather than in the method tables. Deliberately narrow: the
        # directory is one this client just made, and the only question asked
        # of it is whether a file the API was told to produce is there.
        if method in ("scratchDirectory", "producedFile", "discardScratchDirectory"):
            return _scratch(method, self._call_params(body.get("params"), scope))
        call = CALLS.get(method)
        collect = body.get("collect")
        # A streaming method lives in STREAMS, not CALLS, so a step that asks
        # for a fold must be allowed through even though CALLS has no entry.
        if call is None and not collect:
            raise StepError(
                f'SDK method "{method}" is not wired into the Python interpreter yet',
                incomplete=True,
            )
        gap = NOT_YET_ERGONOMIC.get(method)
        if gap:
            raise StepError(gap, incomplete=True)

        params = self._call_params(body.get("params"), scope)

        self._log(f"call {method}")
        response = await self._invoke(method, call, params, collect)

        return _jsonable(response)

    async def _call(self, body: dict[str, Any], scope: dict[str, Any]) -> None:
        scope[body.get("as") or "result"] = await self._call_value(body, scope)
        return None

    async def _start(self, body: dict[str, Any], scope: dict[str, Any]) -> None:
        """Begins a call without waiting for it to finish.

        The concurrency the imperative executors express by not awaiting.
        Wrapped in a task that captures the outcome instead of raising, so a
        started call nobody settles cannot surface as "Task exception was never
        retrieved" during somebody else's test.
        """
        method = body["method"]
        self._log(f"start {method}")
        # The scope as it stands now. JS resolves the call's params before it
        # creates the promise; the task here runs later, so without a snapshot
        # a `$ref` would read whatever a step between `start` and `settle`
        # rebound -- the two clients would disagree about the same body.
        snapshot = dict(scope)

        async def outcome() -> dict[str, Any]:
            try:
                return {"value": await self._call_value(body, snapshot)}
            except BaseException as error:  # noqa: BLE001 - re-raised by settle
                return {"error": error}

        pending = _Pending(asyncio.ensure_future(outcome()))
        scope[body["as"]] = pending
        self._started(scope).append(pending)
        # Gives the loop real time so the request reaches the wire before the
        # next step runs. JS issues the call synchronously, so "started" there
        # means sent; here the call travels through a chain of tasks -- this
        # one, then the pump the SDK's run handle creates, then the transport
        # write -- and a bare yield only advances the first link.
        # `lifecycle-suspend-during-inference` is the test that can tell the
        # difference: the completion it starts was being admitted *after* the
        # suspend it is supposed to race, and the runtime refused it.
        await asyncio.sleep(_START_ON_WIRE_S)
        return None

    async def _settle(self, body: dict[str, Any], scope: dict[str, Any]) -> None:
        """Waits for a call begun by `start`, re-raising its rejection here."""
        handle = self._resolve(body["of"], scope)
        if not isinstance(handle, _Pending):
            raise StepError(f'settle: "{body["of"]}" is not a started call')
        result = await handle.task
        if body.get("expect") == "reject":
            if "error" not in result:
                raise StepError(f"{body['of']} was expected to fail but resolved")
            # Bound the way `_call_error` binds a rejection, so one body can
            # assert on a refusal however the call that produced it was made.
            error = result["error"]
            code = getattr(error, "code", None)
            scope[body.get("as") or "result"] = {
                "code": "" if code is None else str(code),
                "message": str(error),
                "hasCause": error.__cause__ is not None,
                "details": _error_details(error),
            }
            return None
        if "error" in result:
            raise result["error"]
        scope[body.get("as") or "result"] = result["value"]
        return None

    def _started(self, scope: dict[str, Any]) -> list[_Pending]:
        """The run's started calls.

        Lives in the scope so the copy `repeat` makes for each iteration shares
        the same list -- a call started inside a loop is still the run's
        responsibility.
        """
        return scope.setdefault(_STARTED, [])

    async def _drain_started(self, scope: dict[str, Any]) -> None:
        """Waits for every started call the test never settled.

        An in-flight completion that outlives its test goes on holding the
        model while the next test loads its own, and lands its result in the
        middle of somebody else's run. Nothing here is reported: a call the
        test never settled made no claim.
        """
        pending = scope.get(_STARTED)
        if not pending:
            return
        await asyncio.gather(*(p.task for p in pending))

    def _project(self, body: dict[str, Any], scope: dict[str, Any]) -> None:
        source = self._resolve(body["from"], scope)
        value = _walk(source, body["path"])
        join = body.get("join")
        if join is not None and isinstance(value, (list, tuple)):
            value = join.join(js_string(v) for v in value)
        if body.get("count"):
            if not isinstance(value, (list, tuple, bytes, bytearray)):
                raise StepError(f'project count: "{body["path"]}" is not a list')
            value = len(value)
        scope[body["as"]] = value
        return None

    def _assert(
        self,
        body: dict[str, Any],
        scope: dict[str, Any],
        expectation: dict[str, Any],
    ) -> StepResult:
        value = self._resolve(body["on"], scope)
        named = body.get("named")
        if named:
            assertion = ASSERTIONS.get(named)
            if assertion is None:
                raise StepError(
                    f'named assertion "{named}" is not in the Python registry yet',
                    incomplete=True,
                )
            # `with` lets a check compare the result against something the test
            # set up, not only against a constant.
            args = self._resolve(body.get("with", {}), scope)
            result = assertion(value, args)
            result.asserted_value = value
            return result
        result = validate(value, expectation)
        result.asserted_value = value
        return result

    def _call_params(
        self, params: dict[str, Any] | None, scope: dict[str, Any]
    ) -> dict[str, Any]:
        """Resolve a call's parameters, dropping the ones that resolved to nothing.

        An optional reference that is not there must leave the argument out
        entirely, not pass it as None: an SDK that distinguishes "absent" from
        "explicitly nothing" would otherwise see a different call than the test
        meant to make, and the two clients would have to agree on which.
        """
        resolved = self._resolve(params or {}, scope)
        return {k: v for k, v in resolved.items() if v is not _MISSING}

    def _resolve(self, value: Any, scope: dict[str, Any]) -> Any:
        """Replace `$name` / `$params.x` references, recursively.

        A trailing `?` marks the reference optional: a path that is not there
        resolves to the missing marker instead of failing the step. Most calls
        in the catalog take optional arguments, and without this every test
        would have to restate its own params inside its steps just to leave one
        of them out.
        """
        if isinstance(value, str) and value.startswith("$"):
            if value.endswith("?"):
                try:
                    return _walk(scope, value[1:-1])
                except StepError:
                    return _MISSING
            return _walk(scope, value[1:])
        if isinstance(value, dict):
            return {k: self._resolve(v, scope) for k, v in value.items()}
        if isinstance(value, list):
            return [self._resolve(v, scope) for v in value]
        return value


#: Attribute names that differ only in spelling between the clients. The JS
#: error fields are camelCase; these are the same fields.
_ERROR_FIELDS = {
    "prompt_tokens": "promptTokens",
    "ctx_size": "ctxSize",
    "cached_tokens": "cachedTokens",
    "required_tokens": "requiredTokens",
    "model_id": "modelId",
    "request_id": "requestId",
    "partial_text": "partialText",
    "partial_tool_calls": "partialToolCalls",
    "partial_stats": "partialStats",
}


def _error_details(error: BaseException) -> dict[str, Any]:
    """The data a rejection carries beyond its code and message.

    Own attributes only, and never the plumbing: `code` and the cause are
    already reported separately, and a leading underscore means internal. Names
    are spelled the way the JS error spells them, so one catalog body reads the
    same field on both clients.
    """
    details: dict[str, Any] = {}
    for key, value in vars(error).items():
        if key.startswith("_") or key in ("code", "cause", "message"):
            continue
        if callable(value):
            continue
        details[_ERROR_FIELDS.get(key, key)] = _jsonable(value)
    return details


def _jsonable(value: Any) -> Any:
    """Render a response the way the JS client would report it.

    mode="json" matters: without it pydantic leaves enums and dates as Python
    objects. They would not serialise onto the bridge, and worse, the JS client
    reports plain JSON for the same field -- so the cross-client value
    comparison would report drift that is not there. Lists are mapped rather
    than dumped whole, because the ergonomic wrappers return lists of models.

    Dicts are walked for the same reason lists are: a wrapper that regroups
    models into plain records -- `batchCompletion`'s `[{id, final}]` is the one
    that caught this -- leaves a model sitting under a key, where it reaches
    the bridge unserialised and a projection like `[0].final.toolCalls` finds
    nothing to walk.
    """
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    if isinstance(value, tuple):
        return [_jsonable(item) for item in value]
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", by_alias=True)
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        # The ergonomic wrappers hand back dataclasses as well as models --
        # `CompletionFinal` is one -- and a dataclass has no `model_dump`, so
        # it used to pass through untouched with its snake_case fields. JS
        # reports `contentText`; the key has to be spelled the same here or the
        # catalog's own path (`final.contentText`) reads nothing.
        return {
            _camel(field.name): _jsonable(getattr(value, field.name))
            for field in dataclasses.fields(value)
            if not field.name.startswith("_")
        }
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    return value


def _camel(name: str) -> str:
    """snake_case -> camelCase, the inverse of `_snake` for reported values."""
    head, *rest = name.split("_")
    return head + "".join(part.title() for part in rest)


def _last_binding(steps: list[dict[str, Any]]) -> str | None:
    """Name the last value a nested step list bound, for `repeat.collectInto`.

    Mirrors the JS interpreter so both clients collect the same thing.
    """
    for step in reversed(steps):
        if "project" in step:
            return step["project"]["as"]
        if "call" in step:
            return step["call"].get("as") or "result"
        # `settle` binds a value; `start` binds an in-flight call, which is not
        # something a loop can collect.
        if "settle" in step:
            return step["settle"].get("as") or "result"
        if "asset" in step:
            return step["asset"]["as"]
        if "modelSource" in step:
            return step["modelSource"]["as"]
    return None


def _walk(source: Any, path: str) -> Any:
    """Resolve a dotted path with optional [i] indexes."""
    current = source
    segments = path.split(".")
    for position, raw_segment in enumerate(segments):
        wildcard = _WILDCARD.match(raw_segment)
        if wildcard:
            name = wildcard.group(1)
            if name:
                current = _step_into(current, name, path)
            if not isinstance(current, list):
                raise StepError(f'path "{path}" used [*] on a {type(current).__name__}')
            rest = ".".join(segments[position + 1 :])
            if not rest:
                return current
            return [_walk(item, rest) for item in current]

        segment = raw_segment
        match = _INDEX.match(segment)
        index: int | None = None
        if match:
            segment, index = match.group(1), int(match.group(2))
        if segment:
            current = _step_into(current, segment, path)
        if index is not None:
            current = current[index]
    return current


def _step_into(current: Any, segment: str, path: str) -> Any:
    """One named hop along a path.

    JS's walk() guards a null intermediate and raises its own error, which the
    optional-reference handler then swallows. Without the same guard here a
    null raises AttributeError, which that handler does not catch -- so
    `$a.b?` would resolve to nothing on JS and fail the whole test on Python.
    """
    if current is None:
        raise StepError(f'path "{path}" walked off a null at "{segment}"')
    if isinstance(current, dict):
        if segment not in current:
            raise StepError(f'path "{path}" has no "{segment}"')
        return current[segment]
    try:
        return getattr(current, segment)
    except AttributeError as error:
        raise StepError(f'path "{path}" has no "{segment}"') from error
