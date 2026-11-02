"""Unit tests for tetherto.qvac_sdk._api.assess_model_fit's client-side behavior
(candidate key mapping, type inference, descriptor and config handling,
validation) against a fake transport, mirroring the JS assess-model-fit unit
coverage."""

from __future__ import annotations

from typing import Any

import pytest

from tetherto.qvac_sdk import _api as api
from tetherto.qvac_sdk.errors import ModelTypeRequiredError, RequestValidationError
from tetherto.qvac_sdk.models import (
    MMPROJ_QWEN3_5_0_8B_MULTIMODAL_Q8_0,
    QWEN3_5_0_8B_MULTIMODAL_Q4_K_M,
    QWEN3_600M_INST_Q4,
)

OK = {
    "type": "assessModelFit",
    "verdict": "unknown",
    "basis": "system-memory",
    "execution": "sequential",
    "models": [],
    "reasons": ["no evidence"],
    "assumptions": [],
}


class FakeTransport:
    def __init__(self, response=None):
        self.response = response
        # Any (not dict | None): tests index into it right after the call,
        # so a None here should fail the test, not need a narrowing assert.
        self.sent: Any = None

    async def call(self, payload):
        self.sent = payload
        return self.response

    async def call_stream(self, payload):
        raise NotImplementedError
        yield

    async def call_duplex(self, payload, up):
        raise NotImplementedError
        yield


async def test_assess_model_fit_returns_the_parsed_response():
    transport = FakeTransport(response=OK)
    result = await api.assess_model_fit(
        transport, models=[{"model_src": QWEN3_600M_INST_Q4}]
    )
    assert result.verdict.value == "unknown"
    assert result.reasons == ["no evidence"]
    assert transport.sent["type"] == "assessModelFit"


async def test_assess_model_fit_sends_the_whole_descriptor_and_infers_type():
    transport = FakeTransport(response=OK)
    await api.assess_model_fit(transport, models=[{"model_src": QWEN3_600M_INST_Q4}])
    [candidate] = transport.sent["models"]
    assert candidate["modelType"] == "llamacpp-completion"
    assert candidate["modelSrc"]["src"] == QWEN3_600M_INST_Q4.src
    assert candidate["modelSrc"]["registryPath"] == QWEN3_600M_INST_Q4.registry_path
    assert candidate["modelSrc"]["sha256Checksum"] == QWEN3_600M_INST_Q4.sha256_checksum
    assert candidate["modelSrc"]["expectedSize"] == QWEN3_600M_INST_Q4.expected_size


async def test_assess_model_fit_passes_a_string_source_and_explicit_type():
    transport = FakeTransport(response=OK)
    await api.assess_model_fit(
        transport,
        models=[{"model_src": "/models/x.gguf", "model_type": "llamacpp-completion"}],
    )
    [candidate] = transport.sent["models"]
    assert candidate == {
        "modelSrc": "/models/x.gguf",
        "modelType": "llamacpp-completion",
    }


async def test_assess_model_fit_requires_type_for_plain_string_src():
    transport = FakeTransport(response=OK)
    with pytest.raises(ModelTypeRequiredError):
        await api.assess_model_fit(transport, models=[{"model_src": "/models/x.gguf"}])
    assert transport.sent is None


async def test_assess_model_fit_sends_config_companions_as_whole_descriptors():
    transport = FakeTransport(response=OK)
    await api.assess_model_fit(
        transport,
        models=[
            {
                "model_src": QWEN3_5_0_8B_MULTIMODAL_Q4_K_M,
                "model_config": {
                    "ctx_size": 4096,
                    "projectionModelSrc": MMPROJ_QWEN3_5_0_8B_MULTIMODAL_Q8_0,
                },
            }
        ],
    )
    [candidate] = transport.sent["models"]
    config = candidate["modelConfig"]
    assert config["ctx_size"] == 4096
    companion = config["projectionModelSrc"]
    assert companion["src"] == MMPROJ_QWEN3_5_0_8B_MULTIMODAL_Q8_0.src
    assert (
        companion["sha256Checksum"]
        == MMPROJ_QWEN3_5_0_8B_MULTIMODAL_Q8_0.sha256_checksum
    )
    assert (
        companion["registryPath"] == MMPROJ_QWEN3_5_0_8B_MULTIMODAL_Q8_0.registry_path
    )


async def test_assess_model_fit_keeps_a_plain_config_source_as_given():
    transport = FakeTransport(response=OK)
    await api.assess_model_fit(
        transport,
        models=[
            {
                "model_src": "/m/ocr-latin.gguf",
                "model_type": "ggml-ocr",
                "model_config": {"detectorModelSrc": "/m/craft.gguf"},
            }
        ],
    )
    [candidate] = transport.sent["models"]
    assert candidate["modelConfig"] == {"detectorModelSrc": "/m/craft.gguf"}


async def test_assess_model_fit_alias_warns_and_normalizes():
    transport = FakeTransport(response=OK)
    with pytest.warns(
        DeprecationWarning, match='alias.*"llamacpp-completion"'
    ) as record:
        await api.assess_model_fit(
            transport, models=[{"model_src": "/models/x.gguf", "model_type": "llm"}]
        )
    assert record[0].filename == __file__
    [candidate] = transport.sent["models"]
    assert candidate["modelType"] == "llamacpp-completion"


async def test_assess_model_fit_threads_workloads_and_execution():
    transport = FakeTransport(response=OK)
    await api.assess_model_fit(
        transport,
        models=[
            {
                "model_src": "/m/moss-sfx.gguf",
                "model_type": "tts-ggml",
                "tts_workload": {"prompt": "rain on a roof", "seconds": 5},
            }
        ],
        execution="concurrent",
    )
    assert transport.sent["execution"] == "concurrent"
    [candidate] = transport.sent["models"]
    assert candidate["ttsWorkload"] == {"prompt": "rain on a roof", "seconds": 5}


async def test_assess_model_fit_leaves_execution_and_policy_to_the_worker_when_unset():
    transport = FakeTransport(response=OK)
    await api.assess_model_fit(transport, models=[{"model_src": QWEN3_600M_INST_Q4}])
    assert "execution" not in transport.sent
    assert "policy" not in transport.sent


async def test_assess_model_fit_threads_policy():
    transport = FakeTransport(response=OK)
    await api.assess_model_fit(
        transport,
        models=[{"model_src": QWEN3_600M_INST_Q4}],
        policy="interactive-v1",
    )
    assert transport.sent["policy"] == "interactive-v1"


async def test_assess_model_fit_rejects_an_unknown_policy():
    transport = FakeTransport(response=OK)
    policy: Any = "batch-v1"
    with pytest.raises(RequestValidationError, match="policy"):
        await api.assess_model_fit(
            transport,
            models=[{"model_src": QWEN3_600M_INST_Q4}],
            policy=policy,
        )
    assert transport.sent is None


async def test_assess_model_fit_rejects_an_unknown_candidate_key():
    transport = FakeTransport(response=OK)
    with pytest.raises(RequestValidationError, match="'model_cfg'"):
        await api.assess_model_fit(
            transport,
            models=[{"model_src": QWEN3_600M_INST_Q4, "model_cfg": {}}],
        )
    assert transport.sent is None


async def test_assess_model_fit_rejects_an_empty_candidate_list():
    transport = FakeTransport(response=OK)
    with pytest.raises(RequestValidationError, match="assessModelFit"):
        await api.assess_model_fit(transport, models=[])
    assert transport.sent is None


async def test_assess_model_fit_rejects_an_unknown_execution():
    transport = FakeTransport(response=OK)
    execution: Any = "parallel"
    with pytest.raises(RequestValidationError, match="execution"):
        await api.assess_model_fit(
            transport,
            models=[{"model_src": QWEN3_600M_INST_Q4}],
            execution=execution,
        )
    assert transport.sent is None
