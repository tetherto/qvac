"""Generated llamacpp load config accepts every `load_mode` the addon does."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from tetherto.qvac_sdk._generated.models import (
    LoadModelSrcRequestLlamacppCompletionModelConfig,
)


@pytest.mark.parametrize("load_mode", ["none", "mmap", "mlock", "mmap+mlock", "dio"])
def test_load_mode_accepts_every_addon_value(load_mode: str) -> None:
    config = LoadModelSrcRequestLlamacppCompletionModelConfig.model_validate(
        {"ctx_size": 2048, "load_mode": load_mode}
    )

    assert config.load_mode is not None
    assert config.load_mode.value == load_mode


def test_load_mode_rejects_unknown_value() -> None:
    with pytest.raises(ValidationError):
        LoadModelSrcRequestLlamacppCompletionModelConfig.model_validate(
            {"load_mode": "buffered"}
        )


def test_load_mode_is_optional() -> None:
    config = LoadModelSrcRequestLlamacppCompletionModelConfig.model_validate(
        {"ctx_size": 2048}
    )

    assert config.load_mode is None


def test_retired_n_discarded_is_rejected() -> None:
    # The generated model forbids extra fields, so the retired sliding-window
    # key fails construction instead of being silently dropped from the wire.
    with pytest.raises(ValidationError):
        LoadModelSrcRequestLlamacppCompletionModelConfig.model_validate(
            {"ctx_size": 2048, "n_discarded": 256}
        )
