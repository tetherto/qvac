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

from qvac.bare_rpc_transport import BARE_RPC_AVAILABLE, BareRpcTransport
from qvac.completion import completion
from qvac.methods import embed, load_model, ocr_stream
from qvac.models import GTE_LARGE_FP16, LLAMA_3_2_1B_INST_Q4_0, OCR_CRAFT, OCR_LATIN
from qvac.schemas import EmbedRequest, LoadModelRequest, OcrStreamRequest

SDK_DIR = os.environ.get(
    "QVAC_POC_SDK_DIR",
    os.path.join(os.path.dirname(__file__), "..", "..", "sdk"),
)
WORKER_PATH = os.path.join(SDK_DIR, "dist", "server", "worker.js")
BARE_BIN = os.path.join(
    SDK_DIR, "node_modules", "bare-runtime-darwin-arm64", "bin", "bare"
)
IMAGES = os.path.join(SDK_DIR, "e2e", "assets", "images")

# Mirrors the SDK e2e's DETERMINISTIC (completion-tests.ts): greedy + fixed seed
# so a given prompt yields a stable answer across runs.
DETERMINISTIC = {"temp": 0, "seed": 42}

pytestmark = [
    pytest.mark.skipif(not BARE_RPC_AVAILABLE, reason="bare-rpc extra not installed"),
    pytest.mark.skipif(
        not os.path.exists(WORKER_PATH),
        reason=f"no built SDK worker at {WORKER_PATH!r} -- run `bun run build` in packages/sdk",
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


# ---- completion (LLAMA_3_2_1B, the SDK `llm` smoke resource) ----------------
# Prompts + expectations copied verbatim from completion-tests.ts smoke cases.


@pytest.mark.parametrize(
    "prompt, expected",
    [
        ("What is 2+2? Answer with only the number.", "4"),  # completion-streaming
        (
            "What is 5+5? Answer with just the number.",
            "10",
        ),  # completion-temperature-00
    ],
)
async def test_completion_arithmetic_matches_sdk_smoke(transport, prompt, expected):
    model_id = await _load(transport, LLAMA_3_2_1B_INST_Q4_0.src, "llamacpp-completion")
    run = completion(
        transport,
        model_id=model_id,
        history=[{"role": "user", "content": prompt}],
        generation_params=DETERMINISTIC,
    )
    final = await run.final
    assert (
        expected in final.content_text
    ), f"prompt {prompt!r} → {final.content_text!r}, expected to contain {expected!r}"


async def test_completion_multi_turn_recall_matches_sdk_smoke(transport):
    # completion-multi-turn: the assistant must recall "42" from prior history.
    model_id = await _load(transport, LLAMA_3_2_1B_INST_Q4_0.src, "llamacpp-completion")
    run = completion(
        transport,
        model_id=model_id,
        history=[
            {"role": "user", "content": "Remember this number: 42."},
            {"role": "assistant", "content": "I'll remember that the number is 42."},
            {
                "role": "user",
                "content": "What number did I tell you to remember? Answer with just the number.",
            },
        ],
        generation_params=DETERMINISTIC,
    )
    final = await run.final
    assert "42" in final.content_text, f"multi-turn recall → {final.content_text!r}"


# ---- embeddings (GTE_LARGE_FP16, the SDK `embeddings` smoke resource) --------
# The SDK's embed-semantic-similarity only asserts `type: array`; we hold the
# stronger real bar the test is named for -- related texts embed closer than
# unrelated ones.


def _cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb)


async def test_embedding_semantic_similarity_orders_correctly(transport):
    model_id = await _load(transport, GTE_LARGE_FP16.src, "llamacpp-embedding")

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
