import pytest
from pydantic import ValidationError

from tetherto.qvac_sdk._generated.models._internal import (
    LoadModelSrcRequestTtsGgml,
    LoadModelSrcRequestTtsGgmlModelConfigPocket,
)


def pocket_config(**overrides):
    return {
        "ttsEngine": "pocket",
        "mimiModelSrc": "/models/mimi.gguf",
        "frontendSrc": "/models/frontend.json",
        "voiceSrc": "/models/voice.gguf",
        **overrides,
    }


def test_pocket_load_request_preserves_unsigned_seed_and_companion_sources():
    config = pocket_config(seed=4294967295, steps=4, outputSampleRate=24000)
    request = LoadModelSrcRequestTtsGgml.model_validate(
        {
            "modelType": "tts-ggml",
            "modelSrc": "/models/flow-lm.gguf",
            "modelConfig": config,
        }
    )
    assert isinstance(
        request.model_config_, LoadModelSrcRequestTtsGgmlModelConfigPocket
    )
    assert (
        request.model_dump(by_alias=True, exclude_unset=True)["modelConfig"] == config
    )


@pytest.mark.parametrize(
    "override",
    [
        {"useGPU": True},
        {"language": "fr"},
        {"seed": -1},
        {"seed": 4294967296},
        {"steps": 0},
        {"outputSampleRate": 7999},
        {"temperature": float("nan")},
        {"voice": "F1"},
    ],
)
def test_pocket_config_rejects_unsupported_controls(override):
    with pytest.raises(ValidationError):
        LoadModelSrcRequestTtsGgmlModelConfigPocket.model_validate(
            pocket_config(**override)
        )
