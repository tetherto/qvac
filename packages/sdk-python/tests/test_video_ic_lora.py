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
        "lora_strength": 1.37,
        "stg_scale": 1,
        "stg_block": 29,
        "reference_images": ["AQID"],
        "reference_attention_strength": 1,
        "reference_downscale_factor": 1,
        "video_frames": 121,
        "scheduler": "ltx2",
    }


def test_video_ic_lora_request_serializes_wire_fields() -> None:
    request = VideoStreamRequest.model_validate(ingredients_payload())

    assert request.scheduler is not None
    assert type(request.scheduler).__name__ == "VideoStreamRequestScheduler"
    assert request.scheduler.value == "ltx2"
    wire = request.model_dump(mode="json", by_alias=True, exclude_unset=True)
    assert wire["modelId"] == "model-1"
    assert wire["lora_strength"] == 1.37
    assert wire["stg_scale"] == 1
    assert wire["stg_block"] == 29
    assert wire["reference_images"] == ["AQID"]
    assert wire["reference_attention_strength"] == 1
    assert wire["reference_downscale_factor"] == 1
    assert wire["scheduler"] == "ltx2"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("lora", "relative.safetensors"),
        ("lora_strength", 10.1),
        ("stg_scale", -0.1),
        ("stg_block", -1),
        ("reference_images", ["AQID", "BAUG"]),
        ("reference_attention_strength", 1.1),
        ("reference_downscale_factor", 2),
    ],
)
def test_video_ic_lora_generated_field_constraints(field: str, value: object) -> None:
    payload = ingredients_payload()
    payload[field] = value

    with pytest.raises(ValidationError):
        VideoStreamRequest.model_validate(payload)
