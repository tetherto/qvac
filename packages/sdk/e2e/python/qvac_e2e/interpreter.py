"""Executes a declarative test body."""

from __future__ import annotations

import asyncio
import dataclasses
import math
import re
import shutil
import sys
import tempfile
import time
from array import array
from collections.abc import Callable
from contextlib import suppress
from dataclasses import asdict, dataclass, is_dataclass, replace
from pathlib import Path
from typing import Any

from tetherto.qvac_sdk import (
    BciTranscribeRequest,
    DownloadAssetRequest,
    EmbedRequest,
    FinetuneRequest,
    GetLoadedModelInfoRequest,
    GetModelInfoRequest,
    GetSystemResourcesRequest,
    HeartbeatRequest,
    QvacError,
    RagRequest,
    ResumeRequest,
    StateRequest,
    SuspendRequest,
    VectorIndexRequest,
    bci_transcribe,
    bci_transcribe_stream_session,
    cancel,
    completion,
    delete_cache,
    download_asset,
    embed,
    finetune,
    get_loaded_model_info,
    get_model_info,
    get_system_resources,
    heartbeat,
    invoke_plugin,
    invoke_plugin_stream,
    load_model,
    logging_stream,
    model_registry_get_model,
    model_registry_list,
    model_registry_search,
    rag,
    reconstruct_error,
    resume,
    state,
    suspend,
    transcribe_stream_session,
    translate,
    unload_model,
    vector_index,
    vla,
    vla_hparams,
    vla_set_embodiment,
)
from tetherto.qvac_sdk import _streams as streams
from tetherto.qvac_sdk._api import classify
from tetherto.qvac_sdk._generated.error_codes import SERVER_ERROR_CODES
from tetherto.qvac_sdk.model_types import model_src_to_wire, to_source_union

from .assertions import ASSERTIONS, COMPARISONS
from .resources import ASSET_ROOT, ResourceManager, UnknownResourceError
from .result import StepResult, js_string
from .validation import validate
from .wav_pcm import decode_wav_to_mono_f32, f32_to_le_bytes, f32_to_s16_le_bytes

# Contract method name -> how to call it here. Each entry adapts the resolved params to
# this client's signature; the contract name and the params are what the two clients
# agree on, not the calling convention.
_TRANSCRIBE_SESSIONS: dict[str, Any] = {}
_TRANSCRIBE_SESSION_SEQ = 0


def _normalise_transcribe_event(event: Any) -> dict[str, Any]:
    """One event as the catalog sees it."""
    if isinstance(event, str):
        return {"type": "text", "text": event}
    if is_dataclass(event) and not isinstance(event, type):
        raw = asdict(event)
    elif isinstance(event, dict):
        raw = dict(event)
    elif hasattr(event, "model_dump"):
        # A metadata session yields the segment model itself, with no wrapper.
        raw = event.model_dump(mode="json", by_alias=True)
    else:
        raw = {"type": type(event).__name__, "value": _jsonable(event)}
    return {
        _camel(key): _jsonable(value) for key, value in raw.items() if value is not None
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
        prompt=params.get("prompt"),
        metadata=params.get("metadata", False),
        emit_vad_events=params.get("emitVadEvents", False),
        end_of_turn_silence_ms=params.get("endOfTurnSilenceMs"),
        vad_run_interval_ms=params.get("vadRunIntervalMs"),
        parakeet_streaming_config=params.get("parakeetStreamingConfig"),
    )
    _TRANSCRIBE_SESSION_SEQ += 1
    session_id = f"session-{_TRANSCRIBE_SESSION_SEQ}"
    _TRANSCRIBE_SESSIONS[session_id] = session
    return {"sessionId": session_id}


async def _transcribe_stream_write(transport: Any, params: dict[str, Any]) -> Any:
    """Feeds a WAV fixture in, paced."""
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
    if not params.get("id"):
        raise StepError(
            "SDK-server log entries come from the client capturing the worker's stderr, "
            "which this client does not do",
            incomplete=True,
        )
    target_id = params["id"]
    _LOGGING_STREAM_SEQ += 1
    stream_id = f"logs-{_LOGGING_STREAM_SEQ}"
    state: dict[str, Any] = {"collected": [], "cutoffMs": 0, "done": False}
    _LOGGING_STREAMS[stream_id] = state
    subscribed = asyncio.Event()

    async def pump() -> None:
        try:
            entries = logging_stream(transport, target_id)
            # Set before the first `__anext__`, not after: a waiter is woken through
            # `call_soon`, so it resumes only once this task has run on and suspended --
            # and the first thing that first `__anext__` does, before it can suspend, is
            # write the subscribe frame.
            subscribed.set()
            async for entry in entries:
                if state["done"]:
                    break
                state["collected"].append(_jsonable(entry))
        except Exception:  # noqa: BLE001 - an unknown id just closes the stream
            pass
        finally:
            # A stream that never opened must not leave the open step waiting.
            subscribed.set()

    # Read in the background: the catalog triggers the operation between this step and
    # the collect, and nothing would be listening in between.
    state["pump"] = asyncio.ensure_future(pump())
    # And do not return before that subscription is on the wire.
    await subscribed.wait()
    return {"streamId": stream_id}


async def _logging_stream_mark(transport: Any, params: dict[str, Any]) -> Any:
    """Marks the point the logs are counted from."""
    state = _logging_state(params["streamId"])
    state["cutoffMs"] = time.time() * 1000
    return {"markedAt": state["cutoffMs"]}


async def _logging_stream_collect(transport: Any, params: dict[str, Any]) -> Any:
    """Reads until enough entries arrive past the mark, or the window closes."""
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
    pump = state.get("pump")
    if pump is not None and not pump.done():
        # `done` is only read between frames; a pump parked on the next one
        # would hold the subscription open until the worker sent something.
        pump.cancel()
    return {"closed": True}


async def _bci_transcribe_stream_open(transport: Any, params: dict[str, Any]) -> Any:
    """The BCI duplex session, in the same registry as the transcription ones."""
    global _TRANSCRIBE_SESSION_SEQ
    session = bci_transcribe_stream_session(transport, **_snake(params))
    _TRANSCRIBE_SESSION_SEQ += 1
    session_id = f"session-{_TRANSCRIBE_SESSION_SEQ}"
    _TRANSCRIBE_SESSIONS[session_id] = session
    return {"sessionId": session_id}


async def _transcribe_stream_write_bytes(transport: Any, params: dict[str, Any]) -> Any:
    """Writes a fixture in fixed-size chunks, with no decoding."""
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
    """Tears the session down and forgets it."""
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
    """Reads the session's events to the end, or up to `abortAfter` of them."""
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
            # `athrow` rather than `aclose`: the contract under test is that the session
            # unwinds when the consumer errors, not when it finishes.
            with suppress(BaseException):
                await iterator.athrow(RuntimeError("consumer aborted the stream"))
            break
    return {"events": events, "stats": _jsonable(session.stats)}


async def _invoke_plugin(transport: Any, params: dict[str, Any]) -> Any:
    """A plugin call, bound the way JS binds it."""
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
    """Registry info about a model, unwrapped the way JS returns it."""
    request = GetModelInfoRequest.model_validate({"type": "getModelInfo", **params})
    response = await get_model_info(transport, request)
    return _jsonable(response.model_info)


async def _get_loaded_model_info(transport: Any, params: dict[str, Any]) -> Any:
    """The loaded model's record, unwrapped the way JS returns it."""
    request = GetLoadedModelInfoRequest.model_validate(
        {"type": "getLoadedModelInfo", **params}
    )
    response = await get_loaded_model_info(transport, request)
    return _jsonable(response.info)


async def _vla_hparams(transport: Any, params: dict[str, Any]) -> Any:
    """The loaded VLA model's hyperparameters, named the way JS names them."""
    hparams, backend_name = await vla_hparams(transport, model_id=params["modelId"])
    return {"hparams": _jsonable(hparams), "backendName": backend_name}


async def _download_asset(transport: Any, params: dict[str, Any]) -> Any:
    """Fetch an asset, taking a model constant the way the JS client does."""
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
        raise _refusal(envelope, None)
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


def _scratch(method: str, params: dict[str, Any]) -> dict[str, Any]:
    """The scratch-directory surface, kept in step with the JS bindings."""
    if method == "scratchDirectory":
        root = tempfile.mkdtemp(prefix="qvac-e2e-")
        directories: dict[str, str] = {}
        for name in params.get("subdirectories") or []:
            directories[name] = str(Path(root, name))
            Path(root, name).mkdir(parents=True, exist_ok=True)
        _SCRATCH_DIRECTORIES.add(root)
        # The subdirectory paths are handed back rather than joined in the catalog: a
        # step names data, and building a path out of two bound values is not something
        # it can do.
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


def _transcribe_run(transport: Any, params: dict[str, Any]) -> Any:
    request_id, rest = _split_request_id(params, "modelId", "audioChunk")
    # JS builds this request with `...(params.prompt && { prompt })` and
    # `...(params.metadata === true && { metadata: true })`, so a falsy prompt is not a
    # null on the wire -- the field is absent.
    if not rest.get("prompt"):
        rest.pop("prompt", None)
    if rest.get("metadata") is not True:
        rest.pop("metadata", None)
    return streams.transcribe(
        transport,
        model_id=params["modelId"],
        audio=params.get("audioChunk"),
        request_id=request_id,
        **rest,
    )


async def _transcribe(transport: Any, params: dict[str, Any]) -> Any:
    pieces = await _transcribe_run(transport, params).collected
    # Bound under the name that says what came back, exactly as JS binds it: `metadata`
    # returns segments, not a transcript, and a body projecting `text` off one would be
    # reading records under a string's name.
    if params.get("metadata"):
        return {"segments": _jsonable(pieces)}
    return {"text": "".join(pieces)}


async def _vector_index_dispose(transport: Any, params: dict[str, Any]) -> Any:
    """Close an index, tolerating one that was never opened."""
    index_id = params.get("indexId")
    if not index_id:
        return {"disposed": False}
    request = VectorIndexRequest.model_validate(
        {"type": "vectorIndex", "operation": "dispose", "indexId": index_id}
    )
    response = await vector_index(transport, request)
    envelope = response.model_dump(mode="json", by_alias=True)
    if envelope.get("success") is False:
        raise _refusal(envelope, None)
    return {"disposed": True}


async def _vector_index_search(transport: Any, params: dict[str, Any]) -> Any:
    """One query against an index, folded the way JS folds it."""
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
        raise _refusal(envelope, None)
    return {"results": (envelope.get("results") or [[]])[0]}


async def _bci_transcribe(transport: Any, params: dict[str, Any]) -> Any:
    """BCI transcription, with `neuralData` normalised into its wire union."""
    request = BciTranscribeRequest.model_validate(
        {
            "type": "bciTranscribe",
            **params,
            "neuralData": to_source_union(params.get("neuralData")),
        }
    )
    text = ""
    async for response in bci_transcribe(transport, request):
        if getattr(response, "text", None):
            text += response.text
        if getattr(response, "done", False):
            break
    return {"text": text}


async def _classified(transport: Any, params: dict[str, Any]) -> Any:
    """Classification, bound the way JS binds it."""
    return {"results": await classify(transport, **_snake(params))}


def _refusal(envelope: dict[str, Any], failure: str | None) -> QvacError:
    """A `success: false` reply as JS's error for it: a refusal carries only the
    text in `error`, so the name and code come from `failure`."""
    if envelope.get("name") and envelope.get("code") is not None:
        return reconstruct_error(envelope)
    message = str(envelope.get("error") or "request failed")
    if failure is None:
        return QvacError(message)
    return QvacError(message, name=failure, code=SERVER_ERROR_CODES.get(failure))


def _request(
    model: Any,
    method: str,
    call: Callable[..., Any],
    *,
    failure: str | None = None,
    **fixed: Any,
) -> Callable[..., Any]:
    """Wrap a generated stub; `failure` is JS's error for a refusal."""

    async def invoke(transport: Any, params: dict[str, Any]) -> Any:
        response = await call(
            transport, model.model_validate({"type": method, **fixed, **params})
        )
        envelope = (
            response.model_dump() if hasattr(response, "model_dump") else response
        )
        if isinstance(envelope, dict) and envelope.get("success") is False:
            raise _refusal(envelope, failure)
        return response

    return invoke


def _load_model(transport: Any, params: dict[str, Any]) -> Any:
    """Loads a model, and optionally records what the loader reported."""

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
        # JS binds `{ modelId }` so a later step can project it; matching that here
        # keeps one definition working on both clients.
        if want_progress:
            return {"modelId": model_id, "progress": progress}
        return {"modelId": model_id}

    return run()


CALLS: dict[str, Callable[[Any, dict[str, Any]], Any]] = {
    # --- inference, request/reply -------------------------------------------
    "embed": _request(EmbedRequest, "embed", embed),
    "classify": _classified,
    "transcribe": _transcribe,
    "bciTranscribe": _bci_transcribe,
    "vla": lambda transport, params: vla(transport, **_snake(params)),
    "vlaHparams": _vla_hparams,
    "vlaSetEmbodiment": lambda transport, params: vla_set_embodiment(
        transport, model_id=params["modelId"], embodiment=params["embodiment"]
    ),
    # --- models --------------------------------------------------------------
    "loadModel": _load_model,
    "unloadModel": lambda transport, params: unload_model(
        transport, model_id=params["modelId"]
    ),
    "getModelInfo": _get_model_info,
    "getLoadedModelInfo": _get_loaded_model_info,
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
    "ragIngest": _request(
        RagRequest, "rag", rag, failure="RAG_SAVE_FAILED", operation="ingest"
    ),
    "ragCloseWorkspace": _request(
        RagRequest,
        "rag",
        rag,
        failure="RAG_WORKSPACE_CLOSE_FAILED",
        operation="closeWorkspace",
    ),
    "ragDeleteWorkspace": _request(
        RagRequest, "rag", rag, failure="RAG_DELETE_FAILED", operation="deleteWorkspace"
    ),
    "createVectorIndex": _request(
        VectorIndexRequest, "vectorIndex", vector_index, operation="create"
    ),
    "loadVectorIndex": _request(
        VectorIndexRequest, "vectorIndex", vector_index, operation="load"
    ),
    # The vector index is a handle API in JS -- an object with methods on it, keyed by
    # the id the worker assigned.
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
    # A duplex session: open, write audio, end input, read events. A step can
    # only name a method and pass data, so the session lives in a registry here
    # and the catalog addresses it by the id handed out.
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
    # --- plugins -------------------------------------------------------------
    # JS binds `{ result }` so a later step has a field to project; matching
    # that here keeps one definition working on both clients.
    "invokePlugin": _invoke_plugin,
}


def _split_request_id(
    params: dict[str, Any], *taken: str
) -> tuple[Any, dict[str, Any]]:
    """A step's `requestId`, and its other params minus `taken`."""
    rest = {k: v for k, v in params.items() if k != "requestId" and k not in taken}
    return params.get("requestId"), rest


def _snake(params: dict[str, Any]) -> dict[str, Any]:
    """camelCase step params -> the snake_case keyword arguments Python uses."""
    out: dict[str, Any] = {}
    for key, value in params.items():
        out[re.sub(r"(?<!^)(?=[A-Z])", "_", key).lower()] = value
    return out


async def _streamed_text(run: Any) -> str:
    return "".join(
        [
            event.text
            async for event in run.events
            if getattr(event, "type", None) == "contentDelta"
        ]
    )


async def _completion_stream(
    transport: Any, params: dict[str, Any], collect: str
) -> Any:
    """Fold a completion the way `collect` asks for."""
    run = completion(
        transport,
        model_id=params["modelId"],
        request_id=params.get("requestId"),
        history=params["history"],
        stream=params.get("stream", True),
        generation_params=params.get("generationParams"),
        tools=params.get("tools"),
        response_format=params.get("responseFormat"),
        tool_dialect=params.get("toolDialect"),
        kv_cache=params.get("kvCache"),
        capture_thinking=params.get("captureThinking"),
        emit_raw_deltas=params.get("emitRawDeltas"),
    )
    if collect == "text":
        # `tool_calls` rides along with the text because a tools test needs both: the
        # model either answered or called a tool, and which one it did is the question.
        # Two folds would mean two completions.
        # A streaming run's text is read off the events, so a stream that yields nothing fails.
        streamed = (
            asyncio.ensure_future(_streamed_text(run)) if params.get("stream") else None
        )
        calls = await run.tool_calls()
        final = await run.final
        return {
            "text": await streamed if streamed else await run.text(),
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
        request_id=params.get("requestId"),
    )
    if collect == "all":
        # `all` carries the joined text beside the tokens: "it streamed, and this is
        # what it said" is one question, and a second fold would be a second
        # translation.
        tokens = [token async for token in run.token_stream]
        return {
            "all": tokens,
            "text": "".join(tokens),
            "stats": _jsonable(await run.stats),
        }
    if not stream:
        # `translations` rides along: a batch asks about the entries and about the text
        # they join to, and a second fold would be a second translation.
        return {
            "text": await run.text,
            "translations": await run.translations,
            "stats": _jsonable(await run.stats),
        }
    # `text` resolves to the empty string in streaming mode on both clients, so the fold
    # has to follow the mode rather than always await the same handle.
    text = ""
    async for token in run.token_stream:
        text += token
    return {"text": text, "stats": _jsonable(await run.stats)}


async def _ocr_stream(transport: Any, params: dict[str, Any], collect: str) -> Any:
    run = streams.ocr(
        transport,
        model_id=params["modelId"],
        image=params["image"],
        options=params.get("options"),
        request_id=params.get("requestId"),
    )
    # JS's `blocks` resolves empty in streaming mode, the same trap `translate` has: the
    # fold follows the call's own mode rather than always awaiting the same handle.
    if params.get("stream"):
        blocks = [block async for batch in run.stream for block in batch]
    else:
        blocks = await run.result

    # `stats` rides along with every fold: a test that checks timing asks for it from
    # the same run, and a second call would time a different one.
    stats = _jsonable(await run.stats)

    if collect == "blocks":
        return {"blocks": _jsonable(blocks), "stats": stats}
    if collect in ("all", "events"):
        folded = _jsonable(blocks)
        return {"all": folded, "events": folded, "stats": stats}
    if collect == "text":
        # Space, not newline: this is what the executors joined with, and a migrated
        # test has to reproduce what its executor produced.
        return {
            "text": " ".join(getattr(b, "text", "") or "" for b in blocks),
            "stats": stats,
        }
    raise StepError(f'collect: "{collect}" is not defined for ocr', incomplete=True)


async def _transcribe_stream(
    transport: Any, params: dict[str, Any], collect: str
) -> Any:
    """JS's `transcribeStream()` with upfront audio, which is `transcribe`."""
    pieces = await _transcribe_run(transport, params).collected
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
    request_id, rest = _split_request_id(params, "modelId")
    run = streams.text_to_speech(
        transport, model_id=params["modelId"], request_id=request_id, **rest
    )
    if collect == "pcm":
        # The fold has to follow the mode.
        if params.get("stream") is False:
            buffer = (await run.result).samples
        else:
            buffer = [sample async for sample in run.stream]
        return {
            "pcm": buffer,
            "sampleRate": (await run.result).sample_rate,
            "done": await run.done,
        }
    if collect == "all":
        return {"all": [sample async for sample in run.stream]}
    if collect == "events":
        return {"events": [tick async for tick in run.progress_stream]}
    raise StepError(
        f'collect: "{collect}" is not defined for textToSpeech', incomplete=True
    )


async def _images_stream(run: Any, collect: str, method: str) -> Any:
    """diffusion and upscale return the same run shape, so they fold alike."""
    if collect not in ("events", "all", "last"):
        raise StepError(
            f'collect: "{collect}" is not defined for {method}', incomplete=True
        )
    # Progress is drained first because the generator is the live side of the same
    # stream; awaiting the outputs first would leave nothing to iterate.
    events, outputs, stats = await asyncio.gather(
        _drain(run.progress_stream), run.collected, run.stats
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
    request_id, rest = _split_request_id(params, "modelId")
    run = streams.diffusion(
        transport, model_id=params["modelId"], request_id=request_id, **rest
    )
    return await _images_stream(run, collect, "diffusion")


async def _upscale_stream(transport: Any, params: dict[str, Any], collect: str) -> Any:
    run = streams.upscale(
        transport,
        model_id=params["modelId"],
        image=params["image"],
        repeats=params.get("repeats"),
        request_id=params.get("requestId"),
    )
    return await _images_stream(run, collect, "upscale")


async def _drain(stream: Any) -> list[Any]:
    """Collect an async iterable, the way JS's `drain()` does."""
    return [item async for item in stream]


async def _audio_stream(run: Any, collect: str, method: str) -> Any:
    if collect == "pcm":
        # Progress is drained alongside the audio rather than in a second fold: these
        # tests ask whether one run produced audio *and* reported progress, and a second
        # `collect` would be a second generation.
        audio, raw_stats, progress = await asyncio.gather(
            run.result, run.stats, _drain(run.progress_stream)
        )
        return {
            "audio": {
                "pcm": audio.pcm,
                "sampleRate": audio.sample_rate,
                "channels": audio.channels,
                "bitsPerSample": audio.bits_per_sample,
            },
            "stats": _jsonable(raw_stats),
            "events": progress,
        }
    if collect == "events":
        events = [tick async for tick in run.progress_stream]
        await run.result
        return {"events": events}
    raise StepError(
        f'collect: "{collect}" is not defined for {method}', incomplete=True
    )


async def _audio_gen_stream(
    transport: Any, params: dict[str, Any], collect: str
) -> Any:
    request_id, rest = _split_request_id(params, "modelId")
    run = streams.audio_gen(
        transport, model_id=params["modelId"], request_id=request_id, **rest
    )
    return await _audio_stream(run, collect, "audioGen")


async def _audio_edit_stream(
    transport: Any, params: dict[str, Any], collect: str
) -> Any:
    request_id, rest = _split_request_id(params, "modelId", "operations")
    run = streams.audio_edit(
        transport,
        model_id=params["modelId"],
        operations=params["operations"],
        request_id=request_id,
        **rest,
    )
    return await _audio_stream(run, collect, "audioEdit")


async def _audio_understand_stream(
    transport: Any, params: dict[str, Any], collect: str
) -> Any:
    request_id, rest = _split_request_id(params, "modelId")
    run = streams.audio_understand(
        transport, model_id=params["modelId"], request_id=request_id, **rest
    )
    if collect == "text":
        return {"text": await run.result}
    if collect == "events":
        events = [tick async for tick in run.progress_stream]
        await run.result
        return {"events": events}
    raise StepError(
        f'collect: "{collect}" is not defined for audioUnderstand', incomplete=True
    )


async def _finetune_stream(transport: Any, params: dict[str, Any], collect: str) -> Any:
    """Finetune, folded the way JS folds it."""
    if params.get("operation"):
        request = FinetuneRequest.model_validate({"type": "finetune", **params})
        return {"last": _jsonable(await finetune(transport, request))}

    run = streams.finetune_run(transport, **_snake(params))
    if collect == "events":
        events = [_jsonable(tick) async for tick in run.progress_stream]
        return {"events": events, "last": _jsonable(await run.result)}
    if collect == "last":
        return {"last": _jsonable(await run.result)}
    raise StepError(
        f'collect: "{collect}" is not defined for finetune', incomplete=True
    )


async def _batch_completion_stream(
    transport: Any, params: dict[str, Any], collect: str
) -> Any:
    request_id, rest = _split_request_id(params, "modelId", "prompts")
    run = streams.batch_completion(
        transport,
        model_id=params["modelId"],
        prompts=params["prompts"],
        request_id=request_id,
        **rest,
    )
    if collect == "all":
        # Events are drained alongside the results: a streaming batch test asks whether
        # every prompt produced deltas *and* whether its final agrees with them, and a
        # second fold would be a second batch.
        results, events = await asyncio.gather(run.result, _drain(run.stream))
        return {"all": _jsonable(results), "events": _jsonable(events)}
    if collect == "events":
        return {"events": _jsonable([event async for event in run.stream])}
    raise StepError(
        f'collect: "{collect}" is not defined for batchCompletion', incomplete=True
    )


async def _world_step_stream(
    transport: Any, params: dict[str, Any], collect: str
) -> Any:
    run = streams.world_step(
        transport,
        model_id=params["modelId"],
        keys=params.get("keys"),
        request_id=params.get("requestId"),
    )
    if collect == "all":
        return {"all": await run.collected}
    if collect == "last":
        frames = await run.collected
        return {"last": frames[-1] if frames else None, "frameCount": len(frames)}
    if collect == "events":
        frames = await run.collected
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


# Methods whose result is a stream handle rather than a value. A step reaches these
# through `collect`, which names the fold it wants.
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

_INDEX = re.compile(r"^(.*?)\[(\d+)\]$")

#: `field[*]` -- the rest of the path applied to every element.
_WILDCARD = re.compile(r"^(.*?)\[\*\]$")


class _Missing:
    """An optional reference that resolved to nothing."""

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
    """A fixture spelled out in hex: "00010203" is four bytes."""
    try:
        return bytes.fromhex(spec)
    except ValueError as error:
        raise StepError(f'bytes "{spec}" is not an even-length hex string') from error


def _synthesize_tone(spec: str) -> bytes:
    """Raw interleaved stereo 48 kHz Float32 LE PCM for a named tone."""
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
    """A call `start` began and `settle` has yet to await."""

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
        # Evict anything this test did not declare before it starts, so a run does not
        # depend on the order tests happened to arrive in.
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
        # A body that passed cannot be claimed on a client that could not clean up after
        # it, so the teardown's verdict stands.
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
        """Runs the teardown steps, returning only a failure."""
        if not steps:
            return None
        try:
            # Teardown that asserts nothing is clean -- `resume()` is a restoration, not
            # a claim, so `_run_body`'s "asserted nothing" rule must not apply here.
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
            # The first failing check decides the test. A migrated executor often
            # becomes several checks in a row -- shape, then length, then value -- and
            # without this a later passing one would mask an earlier failure.
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
        """A call expected to fail. Binds { code, message }."""
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
            # A gap, or a step that could not run at all -- either way not the rejection
            # this step came for.
            raise
        except Exception as error:  # noqa: BLE001 - the rejection is the subject
            code = getattr(error, "code", None)
            # `hasCause` and a present `code` are what an "errors are structured" test
            # asks about. Binding them here keeps that question answerable without a
            # step that reaches into a language's exception object.
            scope[body["as"]] = {
                "code": "" if code is None else str(code),
                "message": str(error),
                "hasCause": error.__cause__ is not None,
                # The typed errors carry data of their own -- the prompt size and window
                # a context overflow was measured against, say. A test that could only
                # read the message would be asserting on prose; these are the numbers it
                # actually wants.
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
                    f'SDK method "{method}" has no stream fold in the Python '
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
            # Each iteration gets its own scope so a binding from one item cannot leak
            # into the next.
            inner = {**scope, body["as"]: item}
            failure = await self._run_steps(steps, inner, expectation)
            if failure is not None and not failure.passed:
                # An iteration that failed its own check must stop the repeat rather
                # than contribute a half-built value to `collectInto`.
                raise StepError(
                    failure.output or "repeat iteration failed",
                    incomplete=failure.is_incomplete,
                )
            collected.append(inner.get(_last_binding(steps) or "result"))

        scope[body["collectInto"]] = collected
        return None

    # Asset family -> the directory it lives in, mirroring ASSET_ROOTS in
    # tests/shared/step-bindings.ts. Two clients only run the same test if `{ kind:
    # "image", file: "elephant.jpg" }` means the same file on both.
    ASSET_ROOTS = {
        "image": "images",
        "audio": "audio",
        "document": "documents",
        "neural": "neural",
    }

    def _asset(self, body: dict[str, Any], scope: dict[str, Any]) -> None:
        """Resolve a bundled fixture: its bytes, or a path the SDK can open."""
        # `kind` and `file` resolve like any other value: a category whose tests differ
        # only in which fixture they use should carry one body and name the file in its
        # params.
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
        # The asset name arrives from the catalog, and with form="path" it is handed
        # straight to the SDK.
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
            # One key binds the id itself; several bind the list, so a step can address
            # them positionally.
            scope[name] = model_ids[0] if len(model_ids) == 1 else model_ids
        # Convention: the first declared model is addressable as $model so the common
        # single-model test needs no explicit `as`.
        scope.setdefault("model", model_ids[0])
        return None

    async def _call_value(self, body: dict[str, Any], scope: dict[str, Any]) -> Any:
        """Performs one call and returns its value, without binding it."""
        method = body["method"]
        # Not an SDK call, and deliberately not in CALLS: a reload test has to put the
        # model back where the resource manager can find it, and unloading the id
        # directly would leave the manager handing out an id the worker no longer knows.
        if method == "evictResource":
            evicted = self._call_params(body.get("params"), scope)
            await self._resources.evict(str(evicted["dep"]))
            return {"evicted": True}
        # A fresh directory the test may write into, and a look at what landed there.
        # Platform facts, not SDK calls, which is why they are handled here rather than
        # in the method tables.
        if method in ("scratchDirectory", "producedFile", "discardScratchDirectory"):
            return _scratch(method, self._call_params(body.get("params"), scope))
        call = CALLS.get(method)
        collect = body.get("collect")
        # A streaming method lives in STREAMS, not CALLS, so a step that asks for a fold
        # must be allowed through even though CALLS has no entry.
        if call is None and not collect:
            raise StepError(
                f'SDK method "{method}" is not wired into the Python interpreter yet',
                incomplete=True,
            )
        params = self._call_params(body.get("params"), scope)

        self._log(f"call {method}")
        response = await self._invoke(method, call, params, collect)

        return _jsonable(response)

    async def _call(self, body: dict[str, Any], scope: dict[str, Any]) -> None:
        scope[body.get("as") or "result"] = await self._call_value(body, scope)
        return None

    async def _start(self, body: dict[str, Any], scope: dict[str, Any]) -> None:
        """Begins a call without waiting for it to finish."""
        method = body["method"]
        self._log(f"start {method}")
        # The scope as it stands now.
        snapshot = dict(scope)

        async def outcome() -> dict[str, Any]:
            try:
                return {"value": await self._call_value(body, snapshot)}
            except asyncio.CancelledError:
                # Swallowing this would leave the task uncancellable and the run hanging
                # on teardown; only a failure of the call under test is deferred.
                raise
            except Exception as error:  # noqa: BLE001 - re-raised by settle
                return {"error": error}

        pending = _Pending(asyncio.ensure_future(outcome()))
        scope[body["as"]] = pending
        self._started(scope).append(pending)
        # Gives the loop real time so the request reaches the wire before the next step
        # runs.
        await asyncio.sleep(_START_ON_WIRE_S)
        return None

    async def _settle(self, body: dict[str, Any], scope: dict[str, Any]) -> None:
        """Waits for a call begun by `start`, re-raising its rejection here."""
        handle = self._resolve(body["of"], scope)
        if not isinstance(handle, _Pending):
            raise StepError(f'settle: "{body["of"]}" is not a started call')
        within_ms = body.get("withinMs")
        try:
            # Shielded: a missed deadline fails the step, but the call is still drained.
            result = await asyncio.wait_for(
                asyncio.shield(handle.task),
                None if within_ms is None else within_ms / 1000,
            )
        except asyncio.TimeoutError:
            raise StepError(
                f"{body['of']} did not settle within {within_ms}ms"
            ) from None
        if body.get("expect") == "reject":
            if "error" not in result:
                raise StepError(f"{body['of']} was expected to fail but resolved")
            error = result["error"]
            if isinstance(error, StepError):
                # A gap is not the rejection this step came for; `_call_error` guards the
                # same way.
                raise error
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
        """The run's started calls."""
        return scope.setdefault(_STARTED, [])

    async def _drain_started(self, scope: dict[str, Any]) -> None:
        """Waits for every started call the test never settled."""
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
            # `with` lets a check compare the result against something the test set up,
            # not only against a constant.
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
        """Resolve a call's parameters, dropping the ones that resolved to nothing."""
        resolved = self._resolve(params or {}, scope)
        return {k: v for k, v in resolved.items() if v is not _MISSING}

    def _resolve(self, value: Any, scope: dict[str, Any]) -> Any:
        """Replace `$name` / `$params.x` references, recursively."""
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


def _error_details(error: BaseException) -> dict[str, Any]:
    """The data a rejection carries beyond its code and message."""
    details: dict[str, Any] = {}
    for key, value in vars(error).items():
        if key.startswith("_") or key in ("code", "cause", "message"):
            continue
        if callable(value):
            continue
        details[_camel(key)] = _jsonable(value)
    return details


def _jsonable(value: Any) -> Any:
    """Render a response the way the JS client would report it."""
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    if isinstance(value, tuple):
        return [_jsonable(item) for item in value]
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", by_alias=True)
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        # The ergonomic wrappers hand back dataclasses as well as models --
        # `CompletionFinal` is one -- and a dataclass has no `model_dump`.
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
    """Name the last value a nested step list bound, for `repeat.collectInto`."""
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
            try:
                current = current[index]
            except (IndexError, KeyError, TypeError) as error:
                raise StepError(f'path "{path}" has no index {index}') from error
    return current


def _step_into(current: Any, segment: str, path: str) -> Any:
    """One named hop along a path."""
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
