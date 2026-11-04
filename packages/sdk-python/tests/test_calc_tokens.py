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


def test_calc_tokens_rejects_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        CalcTokensRequest.model_validate(
            {"modelId": "llm", "text": "Hello", "tool": []}
        )
