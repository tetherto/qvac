from __future__ import annotations

import pytest
from pydantic import ValidationError

from tetherto.qvac_sdk.schemas import VideoStreamRequest


def ingredients_payload() -> dict[str, object]:
    return {
        "type": "videoStream",
        "modelId": "model-1",
        "mode": "txt2vid",
        "prompt": (
            "Reference sheet: an explorer. "
            "Generated video: the explorer crosses a snowy ridge."
        ),
        "lora": "/models/ltx-2-ingredients.safetensors",
        "loraStrength": 1.37,
        "stgScale": 1,
        "stgBlock": 29,
        "referenceImages": ["AQID"],
        "referenceAttentionStrength": 1,
        "referenceDownscaleFactor": 1,
        "videoFrames": 121,
        "scheduler": "ltx2",
    }


def test_video_ic_lora_request_serializes_wire_fields() -> None:
    request = VideoStreamRequest.model_validate(ingredients_payload())

    assert request.scheduler is not None
    assert type(request.scheduler).__name__ == "VideoStreamRequestScheduler"
    assert request.scheduler.value == "ltx2"
    wire = request.model_dump(mode="json", by_alias=True, exclude_unset=True)
    assert wire["modelId"] == "model-1"
    assert wire["loraStrength"] == 1.37
    assert wire["stgScale"] == 1
    assert wire["stgBlock"] == 29
    assert wire["referenceImages"] == ["AQID"]
    assert wire["referenceAttentionStrength"] == 1
    assert wire["referenceDownscaleFactor"] == 1
    assert wire["scheduler"] == "ltx2"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("lora", "relative.safetensors"),
        ("loraStrength", 10.1),
        ("stgScale", -0.1),
        ("stgBlock", -1),
        ("referenceImages", ["AQID", "BAUG"]),
        ("referenceAttentionStrength", 1.1),
        ("referenceDownscaleFactor", 2),
    ],
)
def test_video_ic_lora_generated_field_constraints(field: str, value: object) -> None:
    payload = ingredients_payload()
    payload[field] = value

    with pytest.raises(ValidationError):
        VideoStreamRequest.model_validate(payload)
