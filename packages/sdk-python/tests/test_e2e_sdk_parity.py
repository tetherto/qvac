"""Real-model e2e mirroring the SDK e2e suite's deterministic success cases
(packages/sdk/e2e/tests/*), run through the PRODUCTION BareRpcTransport --
same prompts, same models, same output expectations as the JS smoke suite,
so the Python client is held to the JS client's output bar, not a loose
"non-empty" check.

Gated exactly like test_bare_rpc_transport.py: needs the bare-rpc extra and a
built SDK worker (`bun run build` in packages/sdk). Models are the SDK e2e's
own smoke resources; all are commonly cached, and fetch over P2P otherwise.
"""

from __future__ import annotations

import math
import os

import pytest
import pytest_asyncio
from _worker_env import BARE_BIN, WORKER_AVAILABLE

from tetherto.qvac_sdk import translate
from tetherto.qvac_sdk.bare_rpc_transport import BARE_RPC_AVAILABLE, BareRpcTransport
from tetherto.qvac_sdk.errors import TranslationFailedError
from tetherto.qvac_sdk.methods import embed, load_model, ocr_stream
from tetherto.qvac_sdk.models import (
    EMBEDDINGGEMMA_300M_Q4_0,
    OCR_CRAFT,
    OCR_LATIN,
    QWEN3_600M_INST_Q4,
)
from tetherto.qvac_sdk.schemas import EmbedRequest, LoadModelRequest, OcrStreamRequest

SDK_DIR = os.environ.get(
    "QVAC_POC_SDK_DIR",
    os.path.join(os.path.dirname(__file__), "..", "..", "sdk"),
)
WORKER_PATH = os.path.join(SDK_DIR, "dist", "server", "worker.js")
IMAGES = os.path.join(SDK_DIR, "e2e", "assets", "images")

pytestmark = [
    pytest.mark.skipif(not BARE_RPC_AVAILABLE, reason="bare-rpc extra not installed"),
    pytest.mark.skipif(
        not WORKER_AVAILABLE,
        reason=f"no built SDK worker + Bare runtime (worker={WORKER_PATH!r}, bare={BARE_BIN!r})",
    ),
]


@pytest_asyncio.fixture
async def transport():
    async with BareRpcTransport([BARE_BIN, WORKER_PATH]) as t:
        yield t


async def _load(transport, model_src, model_type, **model_config):
    response = await load_model(
        transport,
        LoadModelRequest.model_validate(
            {
                "type": "loadModel",
                "modelSrc": model_src,
                "modelType": model_type,
                "modelConfig": model_config,
            }
        ),
    )
    assert response.success, response.error
    assert response.model_id is not None
    return response.model_id


# NOTE: completion arithmetic/multi-turn and translation autodetect moved to
# the shared cross-client corpus (packages/sdk/e2e/conformance/cases.json,
# driven by test_conformance.py). This file keeps the cases whose assertions
# aren't a simple contains/nonempty check: semantic embedding order, OCR
# contains-any, and the translate undetermined-language error path.


# ---- embeddings (EMBEDDINGGEMMA_300M_Q4_0, the SDK `embeddings` smoke resource) --------
# The SDK's embed-semantic-similarity only asserts `type: array`; we hold the
# stronger real bar the test is named for -- related texts embed closer than
# unrelated ones.


def _cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb)


async def test_embedding_semantic_similarity_orders_correctly(transport):
    model_id = await _load(
        transport, EMBEDDINGGEMMA_300M_Q4_0.src, "llamacpp-embedding"
    )

    async def vec(text):
        response = await embed(
            transport,
            EmbedRequest.model_validate(
                {"type": "embed", "modelId": model_id, "text": text}
            ),
        )
        assert response.success, response.error
        return response.embedding

    cat = await vec("a small domestic cat")
    kitten = await vec("a young kitten playing")
    plane = await vec("a commercial passenger airplane")

    related = _cosine(cat, kitten)
    unrelated = _cosine(cat, plane)
    assert related > unrelated, (
        f"semantic similarity mis-ordered: cat~kitten={related:.3f} "
        f"should exceed cat~airplane={unrelated:.3f}"
    )


# ---- OCR (OCR_LATIN + OCR_CRAFT, the SDK `ocr` smoke resource) ---------------
# ocr-simple-test + expectation from ocr-tests.ts.


async def test_ocr_matches_sdk_smoke_expectation(transport):
    image_path = os.path.join(IMAGES, "ocr-simple-test-png.png")
    if not os.path.exists(image_path):
        pytest.skip(f"OCR fixture not present at {image_path!r}")
    model_id = await _load(
        transport,
        OCR_LATIN.src,
        "ggml-ocr",
        langList=["en"],
        detectorModelSrc=OCR_CRAFT.src,
    )
    request = OcrStreamRequest.model_validate(
        {
            "type": "ocrStream",
            "modelId": model_id,
            "image": {"type": "filePath", "value": image_path},
        }
    )
    text = ""
    async for response in ocr_stream(transport, request):
        for block in response.blocks or []:
            text += block.text + " "
    # contains-any from ocr-tests.ts's ocr-simple-test cases.
    expected = [
        "OCR",
        "text",
        "testing",
        "implementation",
        "recognize",
        "Type",
        "enter",
    ]
    lowered = text.lower()
    assert any(
        word.lower() in lowered for word in expected
    ), f"OCR text {text!r} matched none of {expected}"


# ---- translate undetermined-language error (LLAMA_3_2_1B) -------------------
# The autodetect happy path lives in the shared corpus; this keeps the bespoke
# error path: an undetermined source surfaces as a reconstructed
# TranslationFailedError across the RPC boundary.


async def test_translate_undetermined_raises_reconstructed_error(transport):
    model_id = await _load(transport, QWEN3_600M_INST_Q4.src, "llamacpp-completion")
    run = translate(
        transport,
        model_id=model_id,
        text="   ",
        to="en",
        model_type="llamacpp-completion",
        stream=False,
    )
    with pytest.raises(TranslationFailedError):
        await run.text
