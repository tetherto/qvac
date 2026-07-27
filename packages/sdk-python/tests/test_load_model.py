"""Unit tests for tetherto.qvac_sdk.api.load_model's client-side behavior (type
inference, alias normalization, mismatch validation, requestId threading,
progress streaming) and the tetherto.qvac_sdk.model_types helpers -- all against a fake
transport, mirroring the JS load-model unit coverage."""

from __future__ import annotations

from typing import Any

import pytest

from tetherto.qvac_sdk import _api as api
from tetherto.qvac_sdk.errors import (
    ModelLoadFailedError,
    ModelSrcTypeMismatchError,
    ModelTypeRequiredError,
    StreamEndedError,
)
from tetherto.qvac_sdk.model_types import (
    infer_model_type_from_model_src,
    is_builtin_model_type,
    normalize_model_type,
    resolve_canonical_engine,
)
from tetherto.qvac_sdk.models import QWEN3_600M_INST_Q4

OK = {"type": "loadModel", "success": True, "modelId": "m-1"}


class FakeTransport:
    def __init__(self, response=None, stream=None):
        self.response = response
        self.stream = stream or []
        # Any (not dict | None): tests index into it right after the call,
        # so a None here should fail the test, not need a narrowing assert.
        self.sent: Any = None

    async def call(self, payload):
        self.sent = payload
        return self.response

    async def call_stream(self, payload):
        self.sent = payload
        for item in self.stream:
            yield item

    async def call_duplex(self, payload, up):
        raise NotImplementedError
        yield


# ---- model_types helpers -------------------------------------------------


def test_normalize_model_type_resolves_aliases_and_passes_custom_through():
    assert normalize_model_type("llm") == "llamacpp-completion"
    assert normalize_model_type("llamacpp-completion") == "llamacpp-completion"
    assert normalize_model_type("my-custom-plugin") == "my-custom-plugin"


def test_resolve_canonical_engine_handles_legacy_and_onnx_tts():
    assert resolve_canonical_engine("@qvac/llm-llamacpp") == "llamacpp-completion"
    assert resolve_canonical_engine("translation") == "nmtcpp-translation"
    # Registry rows may still say onnx-tts; it routes to the GGML engine.
    assert resolve_canonical_engine("onnx-tts") == "tts-ggml"
    assert resolve_canonical_engine("not-an-engine") is None


def test_is_builtin_model_type():
    assert is_builtin_model_type("llm")
    assert is_builtin_model_type("sdcpp-generation")
    assert not is_builtin_model_type("my-custom-plugin")
    assert not is_builtin_model_type(None)


def test_infer_from_model_constant_and_descriptor_dict():
    # ModelConstant dataclasses carry a canonical engine.
    assert infer_model_type_from_model_src(QWEN3_600M_INST_Q4) == "llamacpp-completion"
    # A descriptor dict falls back from engine to addon.
    assert (
        infer_model_type_from_model_src({"src": "x.gguf", "addon": "embeddings"})
        == "llamacpp-embedding"
    )
    # Plain strings carry nothing to infer from.
    assert infer_model_type_from_model_src("/models/x.gguf") is None


# ---- load_model wrapper --------------------------------------------------


async def test_load_model_infers_type_from_descriptor():
    transport = FakeTransport(response=OK)
    model_id = await api.load_model(transport, model_src=QWEN3_600M_INST_Q4)
    assert model_id == "m-1"
    assert transport.sent["modelType"] == "llamacpp-completion"
    # The wire modelSrc is the descriptor's src string, not the dataclass.
    assert transport.sent["modelSrc"] == QWEN3_600M_INST_Q4.src


async def test_load_model_requires_type_for_plain_string_src():
    transport = FakeTransport(response=OK)
    with pytest.raises(ModelTypeRequiredError):
        await api.load_model(transport, model_src="/models/x.gguf")


async def test_load_model_alias_warns_and_normalizes():
    transport = FakeTransport(response=OK)
    with pytest.warns(DeprecationWarning, match='alias.*"llamacpp-completion"'):
        await api.load_model(transport, model_src="/models/x.gguf", model_type="llm")
    assert transport.sent["modelType"] == "llamacpp-completion"


async def test_load_model_explicit_type_mismatch_raises():
    transport = FakeTransport(response=OK)
    with pytest.raises(ModelSrcTypeMismatchError) as excinfo:
        await api.load_model(
            transport, model_src=QWEN3_600M_INST_Q4, model_type="whisper"
        )
    assert excinfo.value.inferred == "llamacpp-completion"
    assert excinfo.value.resolved == "whispercpp-transcription"


async def test_load_model_generates_request_id_when_omitted():
    transport = FakeTransport(response=OK)
    await api.load_model(transport, model_src=QWEN3_600M_INST_Q4)
    assert isinstance(transport.sent["requestId"], str)
    assert len(transport.sent["requestId"]) == 36  # uuid4 wire shape


async def test_load_model_threads_explicit_request_id():
    transport = FakeTransport(response=OK)
    await api.load_model(transport, model_src=QWEN3_600M_INST_Q4, request_id="req-42")
    assert transport.sent["requestId"] == "req-42"


async def test_load_model_failure_raises_typed_error():
    transport = FakeTransport(
        response={"type": "loadModel", "success": False, "error": "no disk"}
    )
    with pytest.raises(ModelLoadFailedError, match="no disk"):
        await api.load_model(transport, model_src=QWEN3_600M_INST_Q4)


async def test_load_model_reload_config_path_skips_type_handling():
    transport = FakeTransport(response=OK)
    model_id = await api.load_model(
        transport,
        model_id="0123456789abcdef",
        model_type="whisper",
        model_config={"language": "es"},
    )
    assert model_id == "m-1"
    assert transport.sent["modelId"] == "0123456789abcdef"
    assert "modelSrc" not in transport.sent
    # Reload keeps the given type verbatim (the wire accepts the alias) and
    # never threads a client requestId, matching the JS reload path.
    assert transport.sent["modelType"] == "whisper"
    assert "requestId" not in transport.sent


async def test_load_model_with_progress_forwards_events_and_returns_id():
    progress = {
        "type": "modelProgress",
        "downloadKey": "x.gguf",
        "downloaded": 1,
        "total": 2,
        "percentage": 50,
    }
    transport = FakeTransport(stream=[progress, OK])
    seen: list[Any] = []
    model_id = await api.load_model(
        transport, model_src=QWEN3_600M_INST_Q4, on_progress=seen.append
    )
    assert model_id == "m-1"
    assert [event.percentage for event in seen] == [50]
    assert transport.sent["withProgress"] is True


async def test_load_model_with_progress_failure_raises():
    transport = FakeTransport(
        stream=[{"type": "loadModel", "success": False, "error": "download failed"}]
    )
    with pytest.raises(ModelLoadFailedError, match="download failed"):
        await api.load_model(
            transport, model_src=QWEN3_600M_INST_Q4, on_progress=lambda e: None
        )


async def test_load_model_with_progress_stream_ending_early_raises():
    transport = FakeTransport(stream=[])
    with pytest.raises(StreamEndedError):
        await api.load_model(
            transport, model_src=QWEN3_600M_INST_Q4, on_progress=lambda e: None
        )
