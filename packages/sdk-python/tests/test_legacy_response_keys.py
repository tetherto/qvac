"""Responses carry each renamed key under its previous name too, for one
release. The client keeps parsing them and keeps the previous attributes."""

from __future__ import annotations

import pytest

from tetherto.qvac_sdk._generated.models._internal import (
    EmbedResponseStats,
    FinetuneProgressResponse,
)

PROGRESS = {
    "type": "finetune:progress",
    "modelId": "m",
    "isTrain": True,
    "loss": 1.5,
    "lossUncertainty": None,
    "accuracy": 0.5,
    "accuracyUncertainty": None,
    "globalSteps": 3,
    "currentEpoch": 0,
    "currentBatch": 1,
    "totalBatches": 4,
    "elapsedMs": 10.0,
    "etaMs": 30.0,
}


def test_a_response_with_both_spellings_parses_into_the_same_attributes():
    legacy = {
        "is_train": True,
        "loss_uncertainty": None,
        "accuracy_uncertainty": None,
        "global_steps": 3,
        "current_epoch": 0,
        "current_batch": 1,
        "total_batches": 4,
        "elapsed_ms": 10.0,
        "eta_ms": 30.0,
    }
    progress = FinetuneProgressResponse.model_validate({**PROGRESS, **legacy})
    assert progress.global_steps == 3
    assert progress.is_train is True


def test_a_renamed_attribute_keeps_its_previous_name_as_deprecated():
    stats = EmbedResponseStats.model_validate({"ctxSize": 512, "contextSize": 512})
    assert stats.ctx_size == 512
    with pytest.warns(DeprecationWarning):
        assert stats.context_size == 512
