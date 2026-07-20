"""Cross-client conformance (Phase D of the drift plan).

Runs the shared corpus at packages/sdk/e2e/conformance/cases.json through the
Python client against a locally-built worker, asserting the same expectations
the JS runner (packages/sdk/e2e/conformance/run.mjs) checks. One source of
cases for both clients, so they cannot drift on the covered behaviour.

Gated like test_e2e_sdk_parity: needs the bare-rpc extra and a built SDK worker.
"""

from __future__ import annotations

import json
import os

import pytest
import pytest_asyncio

import qvac.models as models
from qvac import completion, load_model, translate
from qvac.bare_rpc_transport import BARE_RPC_AVAILABLE, BareRpcTransport

SDK_DIR = os.environ.get(
    "QVAC_POC_SDK_DIR",
    os.path.join(os.path.dirname(__file__), "..", "..", "sdk"),
)
WORKER_PATH = os.path.join(SDK_DIR, "dist", "server", "worker.js")
BARE_BIN = os.path.join(
    SDK_DIR, "node_modules", "bare-runtime-darwin-arm64", "bin", "bare"
)
CASES_PATH = os.path.join(SDK_DIR, "e2e", "conformance", "cases.json")


def _load_cases() -> list[dict]:
    if not os.path.exists(CASES_PATH):
        return []
    with open(CASES_PATH) as handle:
        return json.load(handle)["cases"]


CASES = _load_cases()

pytestmark = [
    pytest.mark.skipif(not BARE_RPC_AVAILABLE, reason="bare-rpc extra not installed"),
    pytest.mark.skipif(
        not os.path.exists(WORKER_PATH),
        reason=f"no built SDK worker at {WORKER_PATH!r} -- run `bun run build` in packages/sdk",
    ),
    pytest.mark.skipif(not CASES, reason=f"no conformance corpus at {CASES_PATH!r}"),
]


@pytest_asyncio.fixture
async def transport():
    async with BareRpcTransport([BARE_BIN, WORKER_PATH]) as t:
        yield t


def _assert_expectation(expect: dict, text: str, case_id: str) -> None:
    kind = expect["kind"]
    if kind == "contains":
        assert (
            expect["value"] in text
        ), f"{case_id}: {text!r} does not contain {expect['value']!r}"
    elif kind == "nonempty":
        assert text.strip(), f"{case_id}: expected non-empty output, got {text!r}"
    else:
        raise AssertionError(f"{case_id}: unknown expectation kind {kind!r}")


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
async def test_conformance_case(transport, case):
    model_id = await load_model(
        transport,
        model_src=getattr(models, case["model"]),
        model_type=case["modelType"],
        model_config=case.get("modelConfig"),
    )
    category = case["category"]
    params = case["params"]

    if category == "completion":
        completion_run = completion(
            transport,
            model_id=model_id,
            history=params["history"],
            generation_params=params.get("generationParams"),
        )
        final = await completion_run.final
        _assert_expectation(case["expect"], final.content_text, case["id"])
    elif category == "translate":
        translate_run = translate(
            transport,
            model_id=model_id,
            text=params["text"],
            to=params.get("to"),
            from_=params.get("from"),
            model_type=case["modelType"],
            stream=False,
        )
        _assert_expectation(case["expect"], await translate_run.text, case["id"])
    else:
        pytest.skip(
            f"category {category!r} not yet driven by the Python conformance runner"
        )
