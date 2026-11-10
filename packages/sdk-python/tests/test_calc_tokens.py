from collections.abc import AsyncIterable
from typing import Any

import pytest
from pydantic import ValidationError

from tetherto.qvac_sdk._generated import CalcTokensRequest
from tetherto.qvac_sdk._generated.methods import calc_tokens


class FakeTransport:
    def __init__(self) -> None:
        self.payload: dict[str, Any] | None = None

    async def call(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.payload = payload
        return {"type": "calcTokens", "tokens": 1}

    async def call_stream(self, payload: dict[str, Any]):
        raise NotImplementedError
        yield  # pragma: no cover

    async def call_duplex(self, payload: dict[str, Any], up: AsyncIterable[bytes]):
        raise NotImplementedError
        yield  # pragma: no cover


@pytest.mark.asyncio
async def test_calc_tokens_sends_default_discriminator() -> None:
    transport = FakeTransport()
    request = CalcTokensRequest.model_validate({"modelId": "llm", "text": "Hello"})

    response = await calc_tokens(transport, request)

    assert response.tokens == 1
    assert transport.payload == {
        "modelId": "llm",
        "text": "Hello",
        "type": "calcTokens",
    }


@pytest.mark.asyncio
async def test_calc_tokens_sends_nested_tool_defaults() -> None:
    transport = FakeTransport()
    request = CalcTokensRequest.model_validate(
        {
            "modelId": "llm",
            "text": "Hello",
            "tools": [
                {
                    "name": "search",
                    "description": "Search for a document.",
                    "parameters": {
                        "properties": {"query": {"type": "string", "default": None}}
                    },
                }
            ],
        }
    )

    await calc_tokens(transport, request)

    assert transport.payload == {
        "modelId": "llm",
        "text": "Hello",
        "tools": [
            {
                "type": "function",
                "name": "search",
                "description": "Search for a document.",
                "parameters": {
                    "type": "object",
                    "properties": {"query": {"type": "string", "default": None}},
                },
            }
        ],
        "type": "calcTokens",
    }


def test_calc_tokens_rejects_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        CalcTokensRequest.model_validate(
            {"modelId": "llm", "text": "Hello", "tool": []}
        )


def test_calc_tokens_rejects_attachments() -> None:
    with pytest.raises(ValidationError):
        CalcTokensRequest.model_validate(
            {
                "modelId": "llm",
                "text": "What is in this image?",
                "history": [
                    {
                        "role": "user",
                        "content": "Describe this image",
                        "attachments": [{"path": "/tmp/image.png"}],
                    }
                ],
            }
        )


def test_calc_tokens_generated_model_accepts_media_for_worker_validation() -> None:
    request = CalcTokensRequest.model_validate(
        {
            "modelId": "llm",
            "history": [
                {
                    "role": "user",
                    "content": [{"type": "media", "path": "/tmp/image.png"}],
                }
            ],
        }
    )

    assert request.history is not None
    assert request.history[0].content is not None


def test_calc_tokens_accepts_completion_compatible_empty_attachments() -> None:
    request = CalcTokensRequest.model_validate(
        {
            "modelId": "llm",
            "history": [
                {
                    "role": "user",
                    "content": "Hello",
                    "attachments": [],
                    "name": "ignored-by-completion",
                }
            ],
        }
    )

    history = request.history
    assert history is not None
    assert history[0].attachments == []
    assert "name" not in history[0].model_dump()
