"""Unit tests for qvac.api's hand-written wrappers: pure request-shaping and
response-validation logic, so these run against a fake transport rather than
a spawned worker (see test_poc_progress.py / test_poc_smoke.py for the real
end-to-end coverage)."""

from __future__ import annotations

from collections.abc import AsyncIterable
from typing import Any

import pytest

from qvac import api


class FakeTransport:
    """Implements the `Transport` protocol; `response` shape varies per test
    (a single dict for call/call_duplex, an iterable of dicts for
    call_stream), so it's typed `Any` rather than a fixed union."""

    def __init__(self, response: Any) -> None:
        self.response = response
        self.sent: dict[str, Any] | None = None

    async def call(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.sent = payload
        return self.response

    async def call_stream(self, payload: dict[str, Any]):
        self.sent = payload
        for item in self.response:
            yield item

    async def call_duplex(self, payload: dict[str, Any], up: AsyncIterable[bytes]):
        raise NotImplementedError
        yield  # pragma: no cover -- unreachable; makes this an async generator


async def test_cancel_by_request_id():
    transport = FakeTransport({"type": "cancel", "success": True})
    await api.cancel(transport, request_id="req-1")
    assert transport.sent == {
        "type": "cancel",
        "operation": "request",
        "requestId": "req-1",
    }


async def test_cancel_by_request_id_with_clear_cache():
    transport = FakeTransport({"type": "cancel", "success": True})
    await api.cancel(transport, request_id="req-1", clear_cache=True)
    assert transport.sent == {
        "type": "cancel",
        "operation": "request",
        "requestId": "req-1",
        "clearCache": True,
    }


async def test_cancel_broad_by_model_id():
    transport = FakeTransport({"type": "cancel", "success": True})
    await api.cancel(transport, model_id="model-1", kind="completion")
    assert transport.sent == {
        "type": "cancel",
        "operation": "broad",
        "modelId": "model-1",
        "kind": "completion",
    }


async def test_cancel_requires_request_id_or_model_id():
    transport = FakeTransport({"type": "cancel", "success": True})
    with pytest.raises(ValueError):
        await api.cancel(transport)


async def test_cancel_raises_on_failure():
    transport = FakeTransport({"type": "cancel", "success": False, "error": "nope"})
    with pytest.raises(api.CancelFailedError):
        await api.cancel(transport, request_id="req-1")


async def test_unload_model_success():
    transport = FakeTransport({"type": "unloadModel", "success": True})
    await api.unload_model(transport, "model-1")
    assert transport.sent == {
        "type": "unloadModel",
        "modelId": "model-1",
        "clearStorage": False,
    }


async def test_unload_model_raises_on_failure():
    transport = FakeTransport({"type": "unloadModel", "success": False})
    with pytest.raises(api.ModelUnloadFailedError):
        await api.unload_model(transport, "model-1")


async def test_invoke_plugin_unwraps_result():
    transport = FakeTransport({"type": "pluginInvoke", "result": {"ok": True}})
    result = await api.invoke_plugin(transport, "model-1", "vlaRun", params={"x": 1})
    assert result == {"ok": True}
    assert transport.sent == {
        "type": "pluginInvoke",
        "modelId": "model-1",
        "handler": "vlaRun",
        "params": {"x": 1},
    }


async def test_invoke_plugin_stream_skips_done_chunk():
    transport = FakeTransport(
        [
            {"type": "pluginInvokeStream", "result": "a"},
            {"type": "pluginInvokeStream", "result": "b"},
            {"type": "pluginInvokeStream", "result": None, "done": True},
        ]
    )
    results = [
        r async for r in api.invoke_plugin_stream(transport, "model-1", "handler")
    ]
    assert results == ["a", "b"]


REGISTRY_MODEL_ITEM = {
    "name": "TEST_MODEL",
    "registryPath": "p",
    "registrySource": "hf",
    "blobCoreKey": "0" * 64,
    "blobBlockOffset": 0,
    "blobBlockLength": 1,
    "blobByteOffset": 0,
    "modelId": "m",
    "addon": "llm",
    "expectedSize": 1,
    "sha256Checksum": "0" * 64,
    "engine": "llamacpp-completion",
    "quantization": "q4",
    "params": "1B",
}


async def test_model_registry_list_returns_models():
    transport = FakeTransport(
        {"type": "modelRegistryList", "success": True, "models": [REGISTRY_MODEL_ITEM]}
    )
    models = await api.model_registry_list(transport)
    assert len(models) == 1
    assert models[0].registry_path == "p"


async def test_model_registry_list_raises_on_failure():
    transport = FakeTransport(
        {"type": "modelRegistryList", "success": False, "error": "boom"}
    )
    with pytest.raises(api.ModelRegistryQueryFailedError, match="boom"):
        await api.model_registry_list(transport)


async def test_model_registry_search_model_type_aliases_addon():
    transport = FakeTransport(
        {"type": "modelRegistrySearch", "success": True, "models": []}
    )
    await api.model_registry_search(transport, model_type="llm")
    assert transport.sent == {"type": "modelRegistrySearch", "addon": "llm"}


async def test_model_registry_search_model_type_wins_over_addon():
    transport = FakeTransport(
        {"type": "modelRegistrySearch", "success": True, "models": []}
    )
    await api.model_registry_search(transport, model_type="llm", addon="whisper")
    assert transport.sent is not None
    assert transport.sent["addon"] == "llm"


async def test_model_registry_search_passes_filters():
    transport = FakeTransport(
        {"type": "modelRegistrySearch", "success": True, "models": []}
    )
    await api.model_registry_search(
        transport, filter="qwen", engine="llamacpp-completion", quantization="q4"
    )
    assert transport.sent == {
        "type": "modelRegistrySearch",
        "filter": "qwen",
        "engine": "llamacpp-completion",
        "quantization": "q4",
    }


async def test_model_registry_get_model_uses_fallback_error():
    transport = FakeTransport(
        {"type": "modelRegistryGetModel", "success": False, "error": None}
    )
    with pytest.raises(
        api.ModelRegistryQueryFailedError, match="Model not found: hf/p"
    ):
        await api.model_registry_get_model(transport, "p", "hf")


async def test_delete_cache_all():
    transport = FakeTransport({"type": "deleteCache", "success": True})
    result = await api.delete_cache(transport, all=True)
    assert transport.sent == {"type": "deleteCache", "all": True}
    assert result == {"success": True}


async def test_delete_cache_by_kv_cache_key():
    transport = FakeTransport({"type": "deleteCache", "success": True})
    await api.delete_cache(transport, kv_cache_key="key-1", model_id="model-1")
    assert transport.sent == {
        "type": "deleteCache",
        "kvCacheKey": "key-1",
        "modelId": "model-1",
    }


async def test_delete_cache_requires_all_or_kv_cache_key():
    transport = FakeTransport({"type": "deleteCache", "success": True})
    with pytest.raises(api.InvalidDeleteCacheParamsError):
        await api.delete_cache(transport)


async def test_delete_cache_raises_only_when_error_message_present():
    transport = FakeTransport(
        {"type": "deleteCache", "success": False, "error": "boom"}
    )
    with pytest.raises(api.DeleteCacheFailedError):
        await api.delete_cache(transport, all=True)


async def test_delete_cache_silent_failure_without_error_message():
    transport = FakeTransport({"type": "deleteCache", "success": False})
    result = await api.delete_cache(transport, all=True)
    assert result == {"success": False}
