"""Generated request models preserve ordered multimodal history on the wire."""

import pytest
from pydantic import BaseModel, ValidationError

from tetherto.qvac_sdk._generated import models
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


def test_typed_parts_keep_default_discriminators_on_the_wire(history_model):
    text_model = getattr(models, history_model.__name__ + "ContentItemText")
    media_model = getattr(models, history_model.__name__ + "ContentItemMedia")
    history = history_model(
        role="user",
        content=[
            text_model(text="First:"),
            media_model(path="/images/a.jpg"),
            text_model(text="Second:"),
            media_model(path="/images/b.jpg"),
        ],
    )
    assert history.model_dump(mode="json", by_alias=True, exclude_unset=True) == {
        "role": "user",
        "content": [
            {"type": "text", "text": "First:"},
            {"type": "media", "path": "/images/a.jpg"},
            {"type": "text", "text": "Second:"},
            {"type": "media", "path": "/images/b.jpg"},
        ],
    }
