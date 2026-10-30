"""Python port of packages/sdk/examples/rerank.ts.

Loads a small reranker, or a GGUF path or URL passed as the first argument,
scores four support articles against a question, and prints them from most to
least relevant.

Python calls the generated `rerank` stub, so the request is a `RerankRequest`
and the scores are read off the response. `Client` closes the SDK on exit,
which the TypeScript example does with `close()`.

RUN: python examples/rerank.py [path-or-url-to-reranker.gguf]
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import (
    Client,
    RerankRequest,
    load_model,
    rerank,
    unload_model,
)

# Any reranker (cross-encoder) GGUF, such as bge-reranker, jina-reranker or
# Qwen3-Reranker.
DEFAULT_MODEL_SRC = (
    "https://huggingface.co/ggml-org/models/resolve/"
    "499bc8821c6b12b4e53c5bffcb21ec206f212d81/"
    "jina-reranker-v1-tiny-en/ggml-model-f16.gguf"
)

QUERY = "How do I get a refund for a duplicate charge?"
DOCUMENTS = [
    "Refunds for duplicate or failed payments are issued within 5 business days.",
    "Our office is open Monday to Friday, 9am to 5pm.",
    "To change your password, open Settings and choose Security.",
    "If you were charged twice, contact billing with both transaction IDs.",
]


async def main() -> int:
    model_src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_MODEL_SRC

    async with Client() as client:
        t = client.transport
        model_id = None
        try:
            print("▸ Loading reranker", file=sys.stderr)
            model_id = await load_model(
                t, model_src=model_src, model_type="llamacpp-rerank"
            )
            # One score per document, in input order. Higher is more relevant.
            response = await rerank(
                t,
                RerankRequest.model_validate(
                    {
                        "type": "rerank",
                        "modelId": model_id,
                        "query": QUERY,
                        "documents": DOCUMENTS,
                    }
                ),
            )
            ranked = sorted(
                zip(response.scores, DOCUMENTS), key=lambda pair: pair[0], reverse=True
            )
            print(f"Query: {QUERY}\n")
            for score, document in ranked:
                print(f"{score:.3f}  {document}")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
        finally:
            if model_id is not None:
                await unload_model(t, model_id)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
