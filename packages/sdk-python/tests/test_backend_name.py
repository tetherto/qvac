"""Backend names survive generated response validation across SDK clients."""

import pytest
from pydantic import ValidationError

from tetherto.qvac_sdk._generated.models._internal import (
    CompletionStreamResponse,
    EmbedResponse,
)


@pytest.mark.parametrize("backend_name", ["cpu", "metal", "cuda,vulkan"])
def test_backend_name_survives_completion_and_embedding(backend_name):
    completion = CompletionStreamResponse.model_validate(
        {
            "type": "completionStream",
            "events": [
                {
                    "type": "completionStats",
                    "seq": 0,
                    "stats": {"backendName": backend_name},
                }
            ],
        }
    )
    assert completion.events[0].stats.backend_name == backend_name
    embedding = EmbedResponse.model_validate(
        {
            "type": "embed",
            "success": True,
            "embedding": [1, 0],
            "stats": {"backendName": backend_name},
        }
    )
    assert embedding.stats.backend_name == backend_name
    assert embedding.model_dump(by_alias=True)["stats"]["backendName"] == backend_name


def test_backend_name_is_optional_for_older_addons():
    response = EmbedResponse.model_validate(
        {
            "type": "embed",
            "success": True,
            "embedding": [1, 0],
            "stats": {"backendDevice": "cpu"},
        }
    )
    assert response.stats.backend_name is None


@pytest.mark.parametrize("backend_name", [1, ["metal"]])
def test_backend_name_rejects_non_string_values(backend_name):
    with pytest.raises(ValidationError):
        EmbedResponse.model_validate(
            {
                "type": "embed",
                "success": True,
                "embedding": [1, 0],
                "stats": {"backendName": backend_name},
            }
        )
