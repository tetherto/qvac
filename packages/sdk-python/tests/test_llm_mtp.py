"""MTP configuration uses native keys on the wire."""

from __future__ import annotations

from tetherto.qvac_sdk._generated.models import (
    LoadModelSrcRequestLlamacppCompletionModelConfig,
)


def test_mtp_config_round_trip() -> None:
    config = LoadModelSrcRequestLlamacppCompletionModelConfig(
        spec_type="draft-mtp",
        spec_draft_n_max=2,
        spec_draft_n_min=0,
        spec_draft_p_min=0.5,
        spec_draft_backend_sampling=False,
        spec_draft_device="CPU",
        spec_draft_ngl=0,
    )
    assert config.model_dump(by_alias=True, exclude_none=True) == {
        "spec-type": "draft-mtp",
        "spec-draft-n-max": 2,
        "spec-draft-n-min": 0,
        "spec-draft-p-min": 0.5,
        "spec-draft-backend-sampling": False,
        "spec-draft-device": "CPU",
        "spec-draft-ngl": 0,
    }
