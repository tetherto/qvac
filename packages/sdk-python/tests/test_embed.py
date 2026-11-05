from typing import Any

import pytest
from pydantic import ValidationError

from tetherto.qvac_sdk import EmbedRequest


@pytest.mark.parametrize(
    "inputs",
    [
        {"text": "hi", "inputs": ["x"]},
        {"text": "hi", "inputs": None},
        {"inputs": ["x"], "text": None},
    ],
)
def test_embed_request_rejects_both_input_fields(inputs: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        EmbedRequest(**{"model_id": "m", **inputs})
    with pytest.raises(ValidationError):
        EmbedRequest.model_validate({"type": "embed", "modelId": "m", **inputs})


@pytest.mark.parametrize("inputs", [{"text": "hi"}, {"inputs": ["x"]}])
def test_embed_request_serializes_each_input_variant(inputs: dict[str, Any]) -> None:
    request = EmbedRequest(**{"model_id": "m", **inputs})
    assert request.model_dump(by_alias=True, exclude_unset=True) == {
        "modelId": "m",
        **inputs,
    }
