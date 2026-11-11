"""CosyVoice3 speech tokens round-trip from a response into the replay config.

The response models hand the trajectory out as `speech_token_ids`; the
CosyVoice3 load config takes it back as `force_speech_tokens`. Both sides must
share one scalar type, so the list a response returned feeds the replay
configuration as it is, with no per-element conversion.
"""

import pytest
from pydantic import BaseModel

from tetherto.qvac_sdk._generated.models import (
    LoadModelSrcRequestTtsGgmlModelConfigCosyvoice3,
    TextToSpeechResponse,
    TextToSpeechStreamResponse,
    TtsSpeechTokenId,
)

RESPONSE_TYPES: list[type[BaseModel]] = [
    TextToSpeechResponse,
    TextToSpeechStreamResponse,
]


def _frame(response_type: type[BaseModel], tokens: list[int]) -> BaseModel:
    wire_type = (
        "textToSpeech"
        if response_type is TextToSpeechResponse
        else "textToSpeechStream"
    )
    return response_type.model_validate(
        {"type": wire_type, "buffer": [], "done": True, "speechTokenIds": tokens}
    )


@pytest.mark.parametrize("response_type", RESPONSE_TYPES)
def test_returned_speech_tokens_feed_the_replay_config_unchanged(
    response_type: type[BaseModel],
) -> None:
    frame = _frame(response_type, [12, 480, 3])
    returned = getattr(frame, "speech_token_ids")
    assert returned is not None
    assert all(isinstance(token, TtsSpeechTokenId) for token in returned)

    config = LoadModelSrcRequestTtsGgmlModelConfigCosyvoice3(
        force_speech_tokens=returned
    )

    assert config.force_speech_tokens == returned
    wire = config.model_dump(mode="json", by_alias=True, exclude_unset=True)
    assert wire["forceSpeechTokens"] == [12, 480, 3]


def test_replay_config_also_takes_plain_ints() -> None:
    config = LoadModelSrcRequestTtsGgmlModelConfigCosyvoice3(force_speech_tokens=[7, 8])
    wire = config.model_dump(mode="json", by_alias=True, exclude_unset=True)
    assert wire["forceSpeechTokens"] == [7, 8]


@pytest.mark.parametrize("response_type", RESPONSE_TYPES)
def test_speech_tokens_share_one_type_with_the_replay_config(
    response_type: type[BaseModel],
) -> None:
    response_items = response_type.model_fields["speech_token_ids"].annotation
    config_items = LoadModelSrcRequestTtsGgmlModelConfigCosyvoice3.model_fields[
        "force_speech_tokens"
    ].annotation
    assert response_items == config_items
