"""Cross-client conformance (Phase D of the drift plan).

Runs the shared corpus at packages/sdk/e2e/conformance/cases.json through the
Python client against a locally-built worker, asserting the same expectations
the JS runner (packages/sdk/e2e/conformance/run.mjs) checks. One source of
cases for both clients, so they cannot drift on the covered behaviour.

Gated like test_e2e_sdk_parity: needs the bare-rpc extra and a built SDK worker.
"""

from __future__ import annotations

import asyncio
import json
import math
import os

import pytest
import pytest_asyncio
from _worker_env import BARE_BIN, WORKER_AVAILABLE

import tetherto.qvac_sdk.models as models
from tetherto.qvac_sdk import cancel, completion, load_model, translate, unload_model
from tetherto.qvac_sdk.bare_rpc_transport import BARE_RPC_AVAILABLE, BareRpcTransport
from tetherto.qvac_sdk.errors import InferenceCancelledError

# embed / text_to_speech have no ergonomic wrapper -- they're the generated
# stubs, imported from tetherto.qvac_sdk.methods with their request models from tetherto.qvac_sdk.schemas
# (mypy resolves those explicit modules; the flat `tetherto.qvac_sdk` re-export of generated
# names isn't statically visible to mypy -- see the flat-API type-visibility
# follow-up).
from tetherto.qvac_sdk.methods import embed, text_to_speech
from tetherto.qvac_sdk.schemas import EmbedRequest, TextToSpeechRequest

SDK_DIR = os.environ.get(
    "QVAC_POC_SDK_DIR",
    os.path.join(os.path.dirname(__file__), "..", "..", "sdk"),
)
WORKER_PATH = os.path.join(SDK_DIR, "dist", "server", "worker.js")
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
        not WORKER_AVAILABLE,
        reason=f"no built SDK worker + Bare runtime (worker={WORKER_PATH!r}, bare={BARE_BIN!r})",
    ),
    pytest.mark.skipif(not CASES, reason=f"no conformance corpus at {CASES_PATH!r}"),
]


@pytest_asyncio.fixture
async def transport():
    async with BareRpcTransport([BARE_BIN, WORKER_PATH]) as t:
        yield t


def _assert_text(expect: dict, text: str, case_id: str) -> None:
    kind = expect["kind"]
    if kind == "contains":
        assert (
            expect["value"] in text
        ), f"{case_id}: {text!r} does not contain {expect['value']!r}"
    elif kind == "nonempty":
        assert text.strip(), f"{case_id}: expected non-empty output, got {text!r}"
    else:
        raise AssertionError(f"{case_id}: unexpected text expectation {kind!r}")


def _cosine(a, b) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb)


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
async def test_conformance_case(transport, case):
    model_src = getattr(models, case["model"])
    category = case["category"]
    params = case["params"]

    async def _load():
        return await load_model(
            transport,
            model_src=model_src,
            model_type=case["modelType"],
            model_config=case.get("modelConfig"),
        )

    if category == "modelLifecycle":
        model_id = await _load()
        assert model_id, f"{case['id']}: load returned no model id"
        await unload_model(transport, model_id)
        return

    model_id = await _load()

    if category == "completion":
        completion_run = completion(
            transport,
            model_id=model_id,
            history=params["history"],
            generation_params=params.get("generationParams"),
        )
        final = await completion_run.final
        _assert_text(case["expect"], final.content_text, case["id"])

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
        _assert_text(case["expect"], await translate_run.text, case["id"])

    elif category == "embed":

        async def _vec(text: str):
            response = await embed(
                transport,
                EmbedRequest.model_validate(
                    {"type": "embed", "modelId": model_id, "text": text}
                ),
            )
            assert response.success, response.error
            return response.embedding

        related_a = await _vec(params["related"][0])
        related_b = await _vec(params["related"][1])
        unrelated = await _vec(params["unrelated"])
        assert _cosine(related_a, related_b) > _cosine(
            related_a, unrelated
        ), f"{case['id']}: related texts should embed closer than unrelated"

    elif category == "cancel":
        run = completion(transport, model_id=model_id, history=params["history"])

        async def _cancel_soon():
            await asyncio.sleep(0.25)
            await cancel(transport, request_id=run.request_id)

        canceller = asyncio.create_task(_cancel_soon())
        cancelled = False
        async for event in run.events:
            if event.type == "completionDone":
                cancelled = getattr(event, "stop_reason", None) == "cancelled"
        try:
            final = await run.final
            cancelled = cancelled or final.stop_reason == "cancelled"
        except InferenceCancelledError:
            cancelled = True
        # Ensure the background cancel task finished (and surface any error);
        # awaiting the call, not the bare task, also keeps static analysis happy.
        await asyncio.wait_for(canceller, timeout=10)
        assert cancelled, f"{case['id']}: expected the run to report cancellation"

    elif category == "completionOrchestrate":
        # The WORKER runs the multi-turn tool loop and calls back for each tool;
        # this is the Python-only capability the corpus checks. The tool spec is
        # data-driven (name + fixed result) so the case stays language-neutral --
        # the handler just returns the declared result.
        from tetherto.qvac_sdk._completion import completion_orchestrate

        tool_spec = params["tool"]

        async def _handler(_arguments: dict) -> str:
            return tool_spec["result"]

        run = completion_orchestrate(
            transport,
            model_id=model_id,
            history=params["history"],
            tools=[
                {
                    "name": tool_spec["name"],
                    "description": tool_spec["description"],
                    "parameters": {"type": "object", "properties": {}},
                    "handler": _handler,
                }
            ],
            generation_params=params.get("generationParams"),
        )
        async for _event in run.events:
            pass
        final = await run.final
        _assert_text(case["expect"], final.content_text, case["id"])

    elif category == "tts":
        samples: list[float] = []
        async for response in text_to_speech(
            transport,
            TextToSpeechRequest.model_validate(
                {
                    "type": "textToSpeech",
                    "modelId": model_id,
                    "text": params["text"],
                    "inputType": "text",
                    "stream": False,
                }
            ),
        ):
            samples.extend(response.buffer)
        assert samples, f"{case['id']}: text-to-speech produced no audio"

    else:
        pytest.skip(
            f"category {category!r} not yet driven by the Python conformance runner"
        )
