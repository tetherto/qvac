"""Real-model e2e mirroring the SDK e2e suite's deterministic success cases
(packages/sdk/e2e/tests/*), run through the PRODUCTION BareRpcTransport --
same prompts, same models, same output expectations as the JS smoke suite,
so the Python client is held to the JS client's output bar, not a loose
"non-empty" check.

Gated exactly like test_bare_rpc_transport.py: needs bare_rpc and a
built SDK worker (`bun run build` in packages/sdk). Models are the SDK e2e's
own smoke resources; all are commonly cached, and fetch over P2P otherwise.
"""

from __future__ import annotations

import math
import os

import pytest
import pytest_asyncio
from _worker_env import BARE_BIN, WORKER_AVAILABLE, WORKER_PATH

from tetherto.qvac_sdk import translate
from tetherto.qvac_sdk.bare_rpc_transport import BareRpcTransport
from tetherto.qvac_sdk.errors import TranslationFailedError
from tetherto.qvac_sdk.methods import embed, load_model
from tetherto.qvac_sdk.models import (
    EMBEDDINGGEMMA_300M_Q4_0,
    QWEN3_600M_INST_Q4,
)
from tetherto.qvac_sdk.schemas import EmbedRequest, LoadModelRequest

SDK_DIR = os.environ.get(
    "QVAC_POC_SDK_DIR",
    os.path.join(os.path.dirname(__file__), "..", "..", "sdk"),
)

pytestmark = [
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


# OCR is not here any more. This file used to carry a hand-copied
# `contains-any` list from `ocr-tests.ts`'s `ocr-simple-test`; the shared
# catalog now runs that definition itself on the Python client
# (`packages/sdk/e2e/tests/ocr-tests.ts`, 29/29 under `run:local:python`),
# against the same image and the same expectation, so a second copy could only
# drift from it.

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
