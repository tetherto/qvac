"""Generated request models preserve ordered multimodal history on the wire."""

import pytest
from pydantic import BaseModel, ValidationError

from tetherto.qvac_sdk._generated.models import (
    BatchCompletionStreamRequestPromptsItemHistoryItem,
    CompletionOrchestrateRequestHistoryItem,
    CompletionStreamRequestHistoryItem,
)


@pytest.fixture(
    params=[
        CompletionStreamRequestHistoryItem,
        CompletionOrchestrateRequestHistoryItem,
        BatchCompletionStreamRequestPromptsItemHistoryItem,
    ]
)
def history_model(request) -> type[BaseModel]:
    return request.param


@pytest.mark.parametrize(
    "content",
    [
        "Legacy text",
        None,
        [
            {"type": "text", "text": "First:"},
            {"type": "media", "path": "/images/a.jpg"},
            {"type": "text", "text": "Second:"},
            {"type": "media", "path": "/images/b.jpg"},
            {"type": "text", "text": "Compare."},
        ],
    ],
)
def test_history_content_round_trip(history_model, content):
    payload = {"role": "user", "content": content}
    model = history_model.model_validate(payload)
    assert model.model_dump(mode="json", by_alias=True, exclude_unset=True) == payload


@pytest.mark.parametrize(
    "part",
    [None, {"type": "image", "path": "/a.jpg"}, {"type": "media"}, {"type": "text"}],
)
def test_history_content_rejects_malformed_parts(history_model, part):
    with pytest.raises(ValidationError):
        history_model.model_validate({"role": "user", "content": [part]})
