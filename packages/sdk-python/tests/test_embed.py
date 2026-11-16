from typing import Any

import pytest
from pydantic import ValidationError

from tetherto.qvac_sdk import EmbedBatchRequest, EmbedRequest


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
        "type": "embed",
        "modelId": "m",
        **inputs,
    }


@pytest.mark.parametrize(
    "input",
    [
        "query",
        ["prefix", {"media": {"type": "base64", "value": "AQID"}}],
        {"image": "AQID", "width": 1, "height": 1, "channels": 3},
    ],
)
def test_single_embedding_serializes_supported_inputs(input: Any) -> None:
    request = EmbedRequest.model_validate(
        {"type": "embed", "modelId": "m", "input": input}
    )
    assert request.model_dump(by_alias=True, exclude_unset=True) == {
        "type": "embed",
        "modelId": "m",
        "input": input,
    }


def test_embedding_batch_serializes_one_item_and_rejects_ambiguous_fields() -> None:
    payload = {
        "type": "embedBatch",
        "modelId": "m",
        "inputs": [{"image": "AQID"}],
        "requestId": "batch",
    }
    request = EmbedBatchRequest.model_validate(payload)
    assert request.model_dump(by_alias=True, exclude_unset=True) == payload
    with pytest.raises(ValidationError):
        EmbedBatchRequest.model_validate({**payload, "text": "query"})
    with pytest.raises(ValidationError):
        EmbedRequest.model_validate(
            {"type": "embed", "modelId": "m", "input": "query", "inputs": ["query"]}
        )


def test_legacy_inputs_batch_rejects_images() -> None:
    with pytest.raises(ValidationError):
        EmbedRequest.model_validate(
            {"type": "embed", "modelId": "m", "inputs": [{"image": "AQID"}]}
        )
