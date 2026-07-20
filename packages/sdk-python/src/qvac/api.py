"""Hand-written ergonomic wrappers mirroring the JS SDK's `client/api/*.ts`
layer: each function reshapes caller-friendly parameters into the wire
request, validates the response, and raises on failure — the same job the
JS convenience functions do on top of the raw generated stubs
(`qvac.methods`).

Asyncio-native, matching the JS SDK and qvac._transport.Transport.

Only the wrappers whose entire behavior is reproducible from the wire
request/response schemas are here (cancel, unload_model, invoke_plugin(_stream),
model_registry_*, delete_cache). Wrappers with real client-side state or
logic beyond the wire contract (completion's tool/MCP orchestration,
loadModel's type inference, translate's language detection, vla's tensor
marshaling, the duplex streaming session model, ...) are tracked separately
and intentionally not ported here.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from ._generated.models import (
    ModelRegistryGetModelResponseModel,
    ModelRegistryListResponseModelsItem,
    ModelRegistrySearchResponseModelsItem,
)
from ._transport import Transport
from .schemas import (
    CancelRequest,
    CancelResponse,
    DeleteCacheRequest,
    DeleteCacheResponse,
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
    UnloadModelRequest,
    UnloadModelResponse,
)


class CancelFailedError(Exception):
    pass


class ModelUnloadFailedError(Exception):
    def __init__(self, model_id: str) -> None:
        super().__init__(f"failed to unload model {model_id!r}")


class ModelRegistryQueryFailedError(Exception):
    pass


class InvalidDeleteCacheParamsError(Exception):
    def __init__(self) -> None:
        super().__init__("deleteCache needs either all=True or kv_cache_key")


class DeleteCacheFailedError(Exception):
    pass


def _dump(model: Any) -> dict[str, Any]:
    return model.model_dump(mode="json", by_alias=True, exclude_unset=True)


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
        raise ValueError("cancel needs either request_id or model_id")

    request = CancelRequest.model_validate({"type": "cancel", **wire})
    response = CancelResponse.model_validate(await transport.call(_dump(request)))
    if not response.success:
        raise CancelFailedError(response.error)


async def unload_model(
    transport: Transport, model_id: str, clear_storage: bool = False
) -> None:
    """Core wire semantics only — no client-side auto-close of the
    connection or logging-stream cleanup, since a thin per-call Python
    transport has no persistent connection/logging-stream registry to clean
    up (see the JS `unloadModel`'s `autoClose`/`stopLoggingStreamForModel`,
    which depend on that client-side state)."""
    request = UnloadModelRequest.model_validate(
        {"type": "unloadModel", "modelId": model_id, "clearStorage": clear_storage}
    )
    response = UnloadModelResponse.model_validate(await transport.call(_dump(request)))
    if not response.success:
        raise ModelUnloadFailedError(model_id)


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
    kv_cache_key: str | None = None,
    model_id: str | None = None,
) -> dict[str, bool]:
    if all:
        payload: dict[str, Any] = {"type": "deleteCache", "all": True}
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
