"""The whisper `main-gpu` selector has one wire spelling.

The generated pydantic field is named `main_gpu` with alias `main-gpu`. With
`populate_by_name=True`, a second schema key spelled `main_gpu` would populate
both fields from one keyword and serialise both spellings, which the server
rejects as conflicting selectors.
"""

import pytest
from pydantic import BaseModel

from tetherto.qvac_sdk._generated.models import (
    LoadModelSrcRequestWhispercppTranscriptionModelConfigContextParams,
    ReloadConfigRequestModelConfigContextParams,
)

CONTEXT_PARAMS_TYPES: list[type[BaseModel]] = [
    LoadModelSrcRequestWhispercppTranscriptionModelConfigContextParams,
    ReloadConfigRequestModelConfigContextParams,
]


@pytest.mark.parametrize("context_params_type", CONTEXT_PARAMS_TYPES)
@pytest.mark.parametrize("selector", ["dedicated", "integrated", 0, "1"])
def test_main_gpu_serializes_to_the_single_wire_key(
    context_params_type: type[BaseModel], selector: object
) -> None:
    by_name = context_params_type(main_gpu=selector)
    by_alias = context_params_type.model_validate({"main-gpu": selector})
    for config in (by_name, by_alias):
        wire = config.model_dump(mode="json", by_alias=True, exclude_unset=True)
        assert wire == {"main-gpu": selector}


@pytest.mark.parametrize("context_params_type", CONTEXT_PARAMS_TYPES)
def test_main_gpu_has_no_second_field(context_params_type: type[BaseModel]) -> None:
    aliases = {
        field.alias or name for name, field in context_params_type.model_fields.items()
    }
    assert "main-gpu" in aliases
    assert "main_gpu" not in aliases
    assert "main_gpu_1" not in context_params_type.model_fields
