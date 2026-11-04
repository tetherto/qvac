"""The Literal types in tetherto.qvac_sdk._api hold exactly the values the
generated models accept."""

from __future__ import annotations

from enum import Enum
from typing import get_args

from tetherto.qvac_sdk import _api as api
from tetherto.qvac_sdk._generated import models as generated
from tetherto.qvac_sdk.schemas import AssessModelFitRequest


def _enum_values(enum: type[Enum]) -> set[str]:
    return {member.value for member in enum}


def test_model_fit_policy_matches_every_load_request():
    enums = [
        getattr(generated, name)
        for name in dir(generated)
        if name.startswith("LoadModel") and name.endswith("ModelFitPolicy")
    ]
    assert enums
    for enum in enums:
        assert _enum_values(enum) == set(get_args(api.ModelFitPolicy)), enum.__name__


def test_model_fit_execution_matches_the_assess_request():
    assert _enum_values(generated.AssessModelFitRequestExecution) == set(
        get_args(api.ModelFitExecution)
    )


def test_model_fit_headroom_policy_matches_the_assess_request():
    annotation = AssessModelFitRequest.model_fields["policy"].annotation
    assert set(get_args(annotation)) == set(get_args(api.ModelFitHeadroomPolicy))
