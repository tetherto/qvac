"""Hand-written ergonomic wrappers mirroring the JS SDK's `client/api/*.ts`
layer: each function reshapes caller-friendly parameters into the wire
request, validates the response, and raises on failure — the same job the
JS convenience functions do on top of the raw generated stubs
(`tetherto.qvac_sdk.methods`).

Asyncio-native, matching the JS SDK and tetherto.qvac_sdk._transport.Transport.

Only the wrappers whose entire behavior is reproducible from the wire
request/response schemas are here (cancel, unload_model, invoke_plugin(_stream),
model_registry_*, delete_cache). Wrappers with real client-side state or
logic beyond the wire contract (completion's tool/MCP orchestration,
loadModel's type inference, translate's language detection, vla's tensor
marshaling, the duplex streaming session model, ...) are tracked separately
and intentionally not ported here.
"""

from __future__ import annotations

import asyncio
import base64
import uuid
import warnings
from collections.abc import AsyncIterator, Callable
from typing import Any

from pydantic import ValidationError

from ._generated import methods as _methods
from ._generated.models import (
    ModelRegistryGetModelResponseModel,
    ModelRegistryListResponseModelsItem,
    ModelRegistrySearchResponseModelsItem,
)
from ._transport import Transport

# Re-exported so `tetherto.qvac_sdk.api.CancelFailedError` etc. keep resolving; the classes
# now live in tetherto.qvac_sdk.errors as part of the one QvacError hierarchy.
from .errors import (  # noqa: F401
    CancelFailedError,
    DeleteCacheFailedError,
    InvalidCancelParamsError,
    InvalidDeleteCacheParamsError,
    ModelLoadFailedError,
    ModelRegistryQueryFailedError,
    ModelTypeRequiredError,
    ModelUnloadFailedError,
    RequestValidationError,
    StreamEndedError,
)
from .logging_streams import (
    start_logging_stream_for_model,
    stop_logging_stream_for_model,
)
from .model_types import (
    assert_model_src_matches_model_type,
    infer_model_type_from_model_src,
    is_model_type_alias,
    model_src_to_wire,
    normalize_model_type,
)
from .schemas import (
    CancelRequest,
    CancelResponse,
    ClassifyRequest,
    DeleteCacheRequest,
    DeleteCacheResponse,
    LoadModelRequest,
    ModelProgressResponse,
    ModelRegistryGetModelRequest,
    ModelRegistryGetModelResponse,
    ModelRegistryListRequest,
    ModelRegistryListResponse,
    ModelRegistrySearchRequest,
    ModelRegistrySearchResponse,
    PluginInvokeRequest,
    PluginInvokeResponse,
    PluginInvokeStreamRequest,
    PluginInvokeStreamResponse,
    TranslateRequest,
    TranslateResponse,
    UnloadModelRequest,
    UnloadModelResponse,
)


def _dump(model: Any) -> dict[str, Any]:
    return model.model_dump(mode="json", by_alias=True, exclude_unset=True)


def generate_client_request_id() -> str:
    """UUIDv4 for client-side request ids -- the same value goes on the wire
    (`requestId`) and is what `cancel(request_id=...)` targets, mirroring the
    JS SDK's generateClientRequestId contract."""
    return str(uuid.uuid4())


def _start_model_logging(transport: Transport, model_id: str, logger: Any) -> None:
    """Best-effort: a broken logging stream must not fail the load (JS
    catches and warns the same way)."""
    try:
        start_logging_stream_for_model(transport, model_id, logger)
    except Exception:
        warnings.warn(
            f"Failed to start logging stream for model {model_id}",
            RuntimeWarning,
            stacklevel=3,
        )


def _config_srcs_to_wire(value: Any) -> Any:
    """Reduce every model descriptor inside a config to its `src` string.

    A config carries companion models -- Bergamot's `pivotModel.modelSrc`, a
    TTS vocoder's `s3genModelSrc` -- and the wire wants a string there, the
    same as the top-level `modelSrc` this client already reduces. A
    ModelConstant left in place serialises as its own Python field names, which
    the worker does not recognise as a descriptor: it reports
    `modelSrc.startsWith is not a function` and the load fails.
    """
    if isinstance(value, list):
        return [_config_srcs_to_wire(item) for item in value]
    if isinstance(value, dict):
        return {key: _config_srcs_to_wire(item) for key, item in value.items()}
    return model_src_to_wire(value)


def _first_validation_problem(error: ValidationError) -> str:
    """One line describing why a load request was refused.

    A request union reports every arm it failed, which for `loadModel` is
    dozens of lines about model types the caller never named. The arm that
    matches the caller's own `modelType` is the informative one; failing that,
    the first problem reported.
    """
    problems = error.errors()
    if not problems:
        return "loadModel request failed validation"
    problem = problems[0]
    where = ".".join(str(part) for part in problem.get("loc", ()))
    return f"loadModel request failed validation: {where}: {problem.get('msg')}"


def _reject_unknown_config_keys(payload: dict[str, Any], request: Any) -> None:
    """Refuse a `modelConfig` key the model type does not define.

    JS validates load parameters against a strict client schema, so a removed
    or misspelled config field is refused with REQUEST_VALIDATION_FAILED before
    anything reaches the addon -- that is the whole point of
    `model-load-llm-legacy-no-mmap-rejected`. The wire schema is deliberately
    lenient and pydantic drops unknown keys, so without this check the same
    call loads a model configured differently from what the caller asked for,
    silently.

    The legal keys come from the generated model that just accepted the
    request, not from a list kept here: a second copy of the field names would
    drift from the contract the moment a config gains a field.
    """
    sent = payload.get("modelConfig")
    if not isinstance(sent, dict) or not sent:
        return
    accepted = request.model_dump(mode="json", by_alias=True, exclude_unset=True)
    kept = accepted.get("modelConfig")
    if not isinstance(kept, dict):
        return
    unknown = sorted(set(sent) - set(kept))
    if unknown:
        named = ", ".join(repr(key) for key in unknown)
        raise RequestValidationError(
            f"modelConfig has no {named} for modelType " f"{payload.get('modelType')!r}"
        )


async def load_model(
    transport: Transport,
    *,
    model_src: Any = None,
    model_type: str | None = None,
    model_config: dict[str, Any] | None = None,
    model_name: str | None = None,
    model_id: str | None = None,
    on_progress: Callable[[ModelProgressResponse], None] | None = None,
    request_id: str | None = None,
    seed: bool | None = None,
    logger: Any = None,
) -> str:
    """Ergonomic loadModel mirroring JS's `client/api/load-model.ts`:

    - `model_src` accepts a plain string, a `tetherto.qvac_sdk.models` ModelConstant, or a
      descriptor dict; the wire gets the descriptor's `src` string.
    - `model_type` may be omitted when it's inferable from the descriptor's
      engine/addon (raises ModelTypeRequiredError otherwise), accepts
      deprecated aliases ("llm", "whisper", ...) with a DeprecationWarning,
      and is normalized to the canonical form the wire contract requires.
    - An explicit `model_type` that contradicts the descriptor raises
      ModelSrcTypeMismatchError.
    - `model_id` (without `model_src`) is the hot-reload-config path; type
      handling is skipped, matching JS.
    - `request_id` is client-generated when omitted and threaded onto the
      wire so `cancel(request_id=...)` can target this load; pass your own
      to hold the id before awaiting.
    - `on_progress` switches to the streaming call shape and receives each
      ModelProgressResponse.
    - `logger` (anything stdlib-logging-shaped) starts a background logging
      stream forwarding the model's worker logs, mirroring JS's
      startLoggingStreamForModel side effect; `unload_model` stops it.
    """
    is_reload_config = model_id is not None and model_src is None

    resolved_type = model_type
    if not is_reload_config:
        if resolved_type is not None and model_src is not None:
            assert_model_src_matches_model_type(model_src, resolved_type)
        elif resolved_type is None:
            resolved_type = infer_model_type_from_model_src(model_src)
            if not resolved_type:
                raise ModelTypeRequiredError()

        if is_model_type_alias(resolved_type):
            canonical = normalize_model_type(resolved_type)
            warnings.warn(
                f'Model type "{resolved_type}" is an alias and will be '
                f'deprecated. Use "{canonical}" instead.',
                DeprecationWarning,
                stacklevel=2,
            )
        resolved_type = normalize_model_type(resolved_type)

    payload: dict[str, Any] = {"type": "loadModel"}
    if is_reload_config:
        payload["modelId"] = model_id
        if model_type is not None:
            payload["modelType"] = model_type
    else:
        # An addon that ships its own weights is loaded by type alone --
        # `ggml-classification`, `audiogen-ggml`. The caller omits `model_src`,
        # but the wire still carries the field: JS's request transform emits
        # `modelSrc: ''` for exactly these arms, and every arm of the wire union
        # requires it. Omitting the key here matched no arm at all, which is why
        # a bundled classifier could not be loaded from Python.
        payload["modelSrc"] = (
            model_src_to_wire(model_src) if model_src is not None else ""
        )
        payload["modelType"] = resolved_type
        payload["requestId"] = (
            request_id if request_id is not None else generate_client_request_id()
        )
        if model_name is not None:
            payload["modelName"] = model_name
        if seed is not None:
            payload["seed"] = seed
    if model_config is not None:
        payload["modelConfig"] = _config_srcs_to_wire(model_config)

    try:
        request = LoadModelRequest.model_validate(payload)
    except ValidationError as error:
        # JS validates load parameters against its own schema and refuses with
        # REQUEST_VALIDATION_FAILED, so the caller gets an SDK error carrying a
        # code. Letting pydantic's own error out instead gives a refusal with
        # no code and no cause, which is a different contract for the same
        # rejected call.
        raise RequestValidationError(_first_validation_problem(error)) from error
    _reject_unknown_config_keys(payload, request)

    if on_progress is not None:
        async for event in _methods.load_model_with_progress(transport, request):
            if isinstance(event, ModelProgressResponse):
                on_progress(event)
                continue
            if not event.success:
                raise ModelLoadFailedError(event.error)
            assert event.model_id is not None
            if logger is not None:
                _start_model_logging(transport, event.model_id, logger)
            return event.model_id
        raise StreamEndedError()

    response = await _methods.load_model(transport, request)
    if not response.success:
        raise ModelLoadFailedError(response.error)
    assert response.model_id is not None
    if logger is not None:
        _start_model_logging(transport, response.model_id, logger)
    return response.model_id


class TranslateRun:
    """Handles for one translate() call, mirroring the JS return shape:
    `token_stream` (live tokens; empty in non-stream mode), `text` (awaitable
    full text; resolves to "" in stream mode), `translations` (one entry per
    input when `text` was a list, one entry otherwise), and `stats` (awaitable,
    resolved when the terminal done chunk arrives -- in stream mode that
    means once `token_stream` has been consumed to the end). `request_id` is the
    client-generated id threaded on the wire, exposed for `cancel(request_id=...)`,
    mirroring JS."""

    def __init__(
        self,
        token_stream: AsyncIterator[str],
        text: asyncio.Future[str],
        stats: asyncio.Future[Any],
        request_id: str,
        translations: asyncio.Future[list[str]] | None = None,
    ) -> None:
        self.token_stream = token_stream
        self.text = text
        self.stats = stats
        self.request_id = request_id
        if translations is None:
            loop = asyncio.get_running_loop()
            translations = loop.create_future()
            translations.set_result([])
        self.translations = translations


def translate(
    transport: Transport,
    *,
    model_id: str,
    text: str | list[str],
    model_type: str,
    to: str | None = None,
    from_: str | None = None,
    stream: bool = True,
    context: str | None = None,
    request_id: str | None = None,
) -> TranslateRun:
    """Mirrors JS's `client/api/translate.ts`. For LLM-backed translation
    with `from_` omitted, the worker auto-detects the source language and
    raises TranslationFailedError (reconstructed across the RPC boundary) when
    it can't -- detection lives in the worker so every language binding shares
    one detector. NMT models are per-language-pair, so `from_`/`to` don't
    apply to them.

    Must be called with a running event loop (it's a sync constructor for
    async handles, like the JS function)."""
    payload: dict[str, Any] = {
        "type": "translate",
        "modelId": model_id,
        "text": text,
        "stream": stream,
        "modelType": model_type,
    }
    # `from` passes through when provided; when omitted the worker
    # auto-detects the source language (server/bare/ops/translate.ts), so no
    # client-side detector ships here -- one detector, no cross-language drift.
    if from_ is not None:
        payload["from"] = from_
    if to is not None:
        payload["to"] = to
    if context is not None:
        payload["context"] = context
    # Generate a client request id when the caller omits one, thread it on the
    # wire, and expose it on the handle for `cancel(request_id=...)`, mirroring JS.
    resolved_request_id = (
        request_id if request_id is not None else generate_client_request_id()
    )
    payload["requestId"] = resolved_request_id

    request = TranslateRequest.model_validate(payload)
    wire = _dump(request)

    loop = asyncio.get_running_loop()
    stats_future: asyncio.Future[Any] = loop.create_future()

    def _finish_stats(response: TranslateResponse) -> None:
        if not stats_future.done():
            stats_future.set_result(response.stats)

    if stream:

        async def token_stream() -> AsyncIterator[str]:
            async for chunk in transport.call_stream(wire):
                if chunk.get("type") != "translate":
                    continue
                response = TranslateResponse.model_validate(chunk)
                if not response.done:
                    yield response.token
                else:
                    _finish_stats(response)

        text_future: asyncio.Future[str] = loop.create_future()
        text_future.set_result("")
        return TranslateRun(
            token_stream(), text_future, stats_future, resolved_request_id
        )

    async def empty_stream() -> AsyncIterator[str]:
        return
        yield  # pragma: no cover -- makes this an (empty) async generator

    # A batch sends a list and gets one token per input back; a single input
    # gets its text in pieces. JS splits on exactly this and returns
    # `translations` either way, with `text` as their newline join -- without
    # the same split here a batch would come back as one run-together string.
    batched = isinstance(text, list)

    async def collect_translations() -> list[str]:
        collected: list[str] = [] if batched else [""]
        async for chunk in transport.call_stream(wire):
            if chunk.get("type") != "translate":
                continue
            response = TranslateResponse.model_validate(chunk)
            if response.done:
                _finish_stats(response)
            elif batched:
                collected.append(response.token)
            else:
                collected[0] += response.token
        return collected

    # Eager task, matching the JS promise: the wire call starts now, not
    # when `text` is first awaited.
    translations_task = loop.create_task(collect_translations())

    async def joined() -> str:
        return "\n".join(await translations_task)

    return TranslateRun(
        empty_stream(),
        loop.create_task(joined()),
        stats_future,
        resolved_request_id,
        translations_task,
    )


async def classify(
    transport: Transport,
    *,
    model_id: str,
    image: Any,
    top_k: int | None = None,
    width: int | None = None,
    height: int | None = None,
    channels: int | None = None,
    request_id: str | None = None,
) -> list[Any]:
    """Classify an image. Mirrors JS's `classify()`.

    `image` is a JPEG or PNG buffer, or raw RGB bytes with `width`, `height`
    and `channels`. The wire takes base64, and JS encodes it inside its own
    client API -- without the same wrapper here a caller holding bytes, which
    is what reading a file gives, is refused by the request model before the
    call goes out.

    The wire streams; the results arrive on the frame that sets `done`, which
    is the frame JS returns and every other frame it ignores.
    """
    payload: dict[str, Any] = {
        "type": "classify",
        "modelId": model_id,
        "image": _base64_image(image),
    }
    if top_k is not None:
        payload["topK"] = top_k
    if width is not None:
        payload["width"] = width
    if height is not None:
        payload["height"] = height
    if channels is not None:
        payload["channels"] = channels
    if request_id is not None:
        payload["requestId"] = request_id

    request = ClassifyRequest.model_validate(payload)
    async for response in _methods.classify(transport, request):
        if response.done:
            return [_dump(item) for item in response.results]
    return []


def _base64_image(value: Any) -> str:
    """Encode image bytes for the wire, the way JS's `encodeBase64` does."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(value)).decode()
    if isinstance(value, str):
        return value
    raise TypeError(
        f"image must be bytes or a base64 string, got {type(value).__name__}"
    )


async def cancel(
    transport: Transport,
    *,
    request_id: str | None = None,
    model_id: str | None = None,
    kind: str | None = None,
    clear_cache: bool | None = None,
) -> None:
    """Mirrors JS's `cancel()` legacy-shape normalization: a bare
    `request_id` targets one in-flight call (`operation: "request"`); a bare
    `model_id` (with optional `kind`) cancels every in-flight call of that
    kind on that model (`operation: "broad"`)."""
    if request_id is not None:
        wire: dict[str, Any] = {"operation": "request", "requestId": request_id}
        if clear_cache is not None:
            wire["clearCache"] = clear_cache
    elif model_id is not None:
        wire = {"operation": "broad", "modelId": model_id}
        if kind is not None:
            wire["kind"] = kind
    else:
        raise InvalidCancelParamsError()

    request = CancelRequest.model_validate({"type": "cancel", **wire})
    response = CancelResponse.model_validate(await transport.call(_dump(request)))
    if not response.success:
        raise CancelFailedError(response.error)


async def unload_model(
    transport: Transport, model_id: str, clear_storage: bool = False
) -> None:
    """Core wire semantics plus the logging-stream cleanup JS's
    `unloadModel` performs (stopLoggingStreamForModel); connection auto-close
    stays out of scope for the thin per-call transport."""
    request = UnloadModelRequest.model_validate(
        {"type": "unloadModel", "modelId": model_id, "clearStorage": clear_storage}
    )
    response = UnloadModelResponse.model_validate(await transport.call(_dump(request)))
    if not response.success:
        raise ModelUnloadFailedError(model_id)
    stop_logging_stream_for_model(model_id)


async def invoke_plugin(
    transport: Transport, model_id: str, handler: str, params: Any = None
) -> Any:
    request = PluginInvokeRequest.model_validate(
        {
            "type": "pluginInvoke",
            "modelId": model_id,
            "handler": handler,
            "params": params,
        }
    )
    response = PluginInvokeResponse.model_validate(await transport.call(_dump(request)))
    return response.result


async def invoke_plugin_stream(
    transport: Transport, model_id: str, handler: str, params: Any = None
) -> AsyncIterator[Any]:
    request = PluginInvokeStreamRequest.model_validate(
        {
            "type": "pluginInvokeStream",
            "modelId": model_id,
            "handler": handler,
            "params": params,
        }
    )
    async for chunk in transport.call_stream(_dump(request)):
        response = PluginInvokeStreamResponse.model_validate(chunk)
        if not response.done:
            yield response.result


def _validate_registry_response(
    response: Any, fallback_error: str | None = None
) -> None:
    if not response.success:
        raise ModelRegistryQueryFailedError(
            response.error or fallback_error or "Unknown registry error"
        )


async def model_registry_list(
    transport: Transport,
) -> list[ModelRegistryListResponseModelsItem]:
    request = ModelRegistryListRequest.model_validate({"type": "modelRegistryList"})
    response = ModelRegistryListResponse.model_validate(
        await transport.call(_dump(request))
    )
    _validate_registry_response(response)
    return response.models or []


async def model_registry_search(
    transport: Transport,
    *,
    filter: str | None = None,
    engine: str | None = None,
    quantization: str | None = None,
    addon: str | None = None,
    model_type: str | None = None,
) -> list[ModelRegistrySearchResponseModelsItem]:
    """`model_type` is an accepted alias for `addon`, mirroring JS's
    `modelRegistrySearch` — if both are given, `model_type` wins."""
    payload: dict[str, Any] = {"type": "modelRegistrySearch"}
    if filter is not None:
        payload["filter"] = filter
    if engine is not None:
        payload["engine"] = engine
    if quantization is not None:
        payload["quantization"] = quantization
    resolved_addon = model_type if model_type is not None else addon
    if resolved_addon is not None:
        payload["addon"] = resolved_addon

    request = ModelRegistrySearchRequest.model_validate(payload)
    response = ModelRegistrySearchResponse.model_validate(
        await transport.call(_dump(request))
    )
    _validate_registry_response(response)
    return response.models or []


async def model_registry_get_model(
    transport: Transport, registry_path: str, registry_source: str
) -> ModelRegistryGetModelResponseModel:
    request = ModelRegistryGetModelRequest.model_validate(
        {
            "type": "modelRegistryGetModel",
            "registryPath": registry_path,
            "registrySource": registry_source,
        }
    )
    response = ModelRegistryGetModelResponse.model_validate(
        await transport.call(_dump(request))
    )
    _validate_registry_response(
        response, f"Model not found: {registry_source}/{registry_path}"
    )
    assert response.model is not None
    return response.model


async def delete_cache(
    transport: Transport,
    *,
    all: bool | None = None,
    auto: bool | None = None,
    kv_cache_key: str | None = None,
    model_id: str | None = None,
) -> dict[str, bool]:
    """Delete KV cache files.

    ``all`` wipes the cache root, caller-owned named caches included. ``auto``
    reclaims only the engine-generated automatic caches that no request is
    using, covering the whole cache directory — which is shared by every QVAC
    process under the same home directory. ``kv_cache_key`` targets one key,
    optionally narrowed to one ``model_id``.
    """
    if all:
        payload: dict[str, Any] = {"type": "deleteCache", "all": True}
    elif auto:
        payload = {"type": "deleteCache", "auto": True}
    elif kv_cache_key is not None:
        payload = {"type": "deleteCache", "kvCacheKey": kv_cache_key}
        if model_id is not None:
            payload["modelId"] = model_id
    else:
        raise InvalidDeleteCacheParamsError()

    request = DeleteCacheRequest.model_validate(payload)
    response = DeleteCacheResponse.model_validate(await transport.call(_dump(request)))
    if not response.success and response.error:
        raise DeleteCacheFailedError(response.error)
    return {"success": response.success}
