from collections import UserDict

import pytest
from pydantic import ValidationError

from tetherto.qvac_sdk._generated.models._internal import (
    LoadModelSrcRequestSdcppGenerationModelConfig,
)


@pytest.mark.parametrize("budget", [0, -1, 2.5, "6", "cuda0=6,vulkan0=4"])
@pytest.mark.parametrize("residency", ["diffusion=cpu", "diffusion=disk"])
def test_diffusion_memory_controls_serialize(
    budget: float | str, residency: str
) -> None:
    config = LoadModelSrcRequestSdcppGenerationModelConfig(
        backend="cuda0", params_backend=residency, max_vram=budget, stream_layers=False
    )
    assert config.model_dump(by_alias=True, exclude_unset=True) == {
        "backend": "cuda0",
        "params_backend": residency,
        "max_vram": budget,
        "stream_layers": False,
    }


@pytest.mark.parametrize("budget", ["6", "cuda0=6,vulkan0=4"])
def test_string_budgets_read_back_as_plain_str(budget: str) -> None:
    # A constraint on a union member makes datamodel-codegen wrap the arm in a
    # RootModel, so the attribute stops being a str while model_dump still
    # unwraps it -- invisible to a dump-only assertion. Read the attribute.
    config = LoadModelSrcRequestSdcppGenerationModelConfig(max_vram=budget)
    assert isinstance(config.max_vram, str)
    assert config.max_vram == budget
    assert config.max_vram.startswith(budget[0])


@pytest.mark.parametrize("key", ["clip_on_cpu", "vae_on_cpu", "control_net_cpu"])
@pytest.mark.parametrize("value", [True, False, None])
def test_removed_diffusion_options_are_rejected(key: str, value: bool | None) -> None:
    assert key not in LoadModelSrcRequestSdcppGenerationModelConfig.model_fields
    with pytest.raises(ValidationError):
        LoadModelSrcRequestSdcppGenerationModelConfig.model_validate({key: value})


def test_removed_diffusion_options_reject_mapping_inputs_with_guidance() -> None:
    with pytest.raises(ValidationError, match="params_backend"):
        LoadModelSrcRequestSdcppGenerationModelConfig.model_validate(
            UserDict({"clip_on_cpu": True})
        )


def test_unknown_diffusion_options_are_ignored() -> None:
    config = LoadModelSrcRequestSdcppGenerationModelConfig.model_validate(
        {"backend": "cuda0", "unknown_option": True}
    )
    assert config.model_dump(exclude_unset=True) == {"backend": "cuda0"}
