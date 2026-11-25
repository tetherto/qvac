"""Responses accept fields a newer worker adds, except in strict objects.

The JS client drops unknown response fields unless the Zod object is strict;
these tests hold the generated Python models to the same rule.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from tetherto.qvac_sdk._generated import CompletionStreamResponse, TranscribeResponse


def test_a_new_field_in_a_non_strict_response_is_ignored() -> None:
    response = TranscribeResponse.model_validate(
        {"type": "transcribe", "text": "hello", "language": "en"}
    )
    assert response.text == "hello"
    assert "language" not in response.model_dump()


def test_a_new_field_in_a_strict_response_is_rejected() -> None:
    with pytest.raises(ValidationError, match="language"):
        CompletionStreamResponse.model_validate(
            {"type": "completionStream", "done": True, "language": "en"}
        )
