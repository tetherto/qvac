import pytest
from pydantic import ValidationError

from tetherto.qvac_sdk._generated.models._internal import (
    LoadModelSrcRequestSdcppGenerationModelConfigWorld,
)


@pytest.mark.parametrize("budget", [0, -1, 2.5, "6", "cuda0=6,vulkan0=4"])
@pytest.mark.parametrize("residency", ["diffusion=cpu", "diffusion=disk,vae=cpu"])
def test_world_memory_controls_serialize_to_camel_case(
    budget: float | str, residency: str
) -> None:
    config = LoadModelSrcRequestSdcppGenerationModelConfigWorld(
        params_backend=residency, max_vram=budget, stream_layers=True, verbosity=3
    )
    assert config.model_dump(mode="json", by_alias=True, exclude_unset=True) == {
        "paramsBackend": residency,
        "maxVram": budget,
        "streamLayers": True,
        "verbosity": 3,
    }


def test_world_memory_controls_accept_camel_case_input() -> None:
    config = LoadModelSrcRequestSdcppGenerationModelConfigWorld.model_validate(
        {"paramsBackend": "diffusion=cpu", "maxVram": -1, "streamLayers": False}
    )
    assert config.params_backend == "diffusion=cpu"
    assert config.max_vram == -1
    assert config.stream_layers is False


@pytest.mark.parametrize("budget", ["6", "cuda0=6,vulkan0=4"])
def test_world_string_budgets_read_back_as_plain_str(budget: str) -> None:
    # Guards against datamodel-codegen wrapping the string arm in a RootModel,
    # which model_dump would unwrap and hide. Read the attribute.
    config = LoadModelSrcRequestSdcppGenerationModelConfigWorld(max_vram=budget)
    assert isinstance(config.max_vram, str)
    assert config.max_vram == budget


def test_lax_boolean_strings_serialize_as_booleans() -> None:
    # Pydantic's lax mode coerces "yes"/"true"/"1"; the wire still gets a bool.
    config = LoadModelSrcRequestSdcppGenerationModelConfigWorld(stream_layers="yes")
    assert config.model_dump(mode="json", by_alias=True, exclude_unset=True) == {
        "streamLayers": True
    }


@pytest.mark.parametrize(
    "fields",
    [
        {"verbosity": 4},
        {"verbosity": -1},
        {"stream_layers": "maybe"},
        {"params_backend": "x" * 4097},
    ],
)
def test_invalid_world_memory_controls_are_rejected(fields: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        LoadModelSrcRequestSdcppGenerationModelConfigWorld.model_validate(fields)
