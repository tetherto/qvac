import pytest
from pydantic import BaseModel, ValidationError

from tetherto.qvac_sdk._generated.models import (
    LoadModelSrcRequestGgmlVlaModelConfig,
    LoadModelSrcRequestLlamacppCompletionModelConfig,
    LoadModelSrcRequestLlamacppEmbeddingModelConfig,
)

CONFIG_TYPES: list[type[BaseModel]] = [
    LoadModelSrcRequestLlamacppCompletionModelConfig,
    LoadModelSrcRequestLlamacppEmbeddingModelConfig,
    LoadModelSrcRequestGgmlVlaModelConfig,
]


@pytest.mark.parametrize("config_type", CONFIG_TYPES)
def test_backend_array_serialization_preserves_order(
    config_type: type[BaseModel],
) -> None:
    config = config_type.model_validate({"backend": ["vulkan", "cuda"]})
    assert config.model_dump(mode="json", exclude_none=True)["backend"] == [
        "vulkan",
        "cuda",
    ]
    assert config_type().model_dump()["backend"] is None


@pytest.mark.parametrize("config_type", CONFIG_TYPES)
@pytest.mark.parametrize(
    "backend", ["cuda", "cuda,vulkan", [], ["unknown"], ["cuda", "unknown"], [1]]
)
def test_invalid_backend_arrays_are_rejected(
    config_type: type[BaseModel], backend: object
) -> None:
    with pytest.raises(ValidationError):
        config_type.model_validate({"backend": backend})


@pytest.mark.parametrize("name", ["cpu", "hip", "rocm", "sycl"])
def test_vla_backend_names_are_model_specific(name: str) -> None:
    config = LoadModelSrcRequestGgmlVlaModelConfig.model_validate({"backend": [name]})
    assert config.model_dump(mode="json", exclude_none=True)["backend"] == [name]
    for config_type in CONFIG_TYPES[:2]:
        with pytest.raises(ValidationError):
            config_type.model_validate({"backend": [name]})
