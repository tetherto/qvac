"""The llamacpp load config rejects unknown keys, so the retired `no_mmap`
raises instead of being silently dropped into a default mmap load."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from tetherto.qvac_sdk._generated.models import (
    LoadModelSrcRequestLlamacppCompletionModelConfig,
)


@pytest.mark.parametrize(
    "load_mode", ["none", "mmap", "mlock", "mmap+mlock", "dio"]
)
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


def test_retired_no_mmap_is_rejected_not_dropped() -> None:
    with pytest.raises(ValidationError) as excinfo:
        LoadModelSrcRequestLlamacppCompletionModelConfig.model_validate(
            {"ctx_size": 2048, "no_mmap": True}
        )

    # extra_forbidden, not a coerced or ignored field: dropping the key would
    # leave the caller on a default mmap load with no error.
    assert excinfo.value.errors()[0]["type"] == "extra_forbidden"


def test_load_mode_is_optional() -> None:
    config = LoadModelSrcRequestLlamacppCompletionModelConfig.model_validate(
        {"ctx_size": 2048}
    )

    assert config.load_mode is None
