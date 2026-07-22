"""Python port of packages/sdk/examples/embed-p2p.ts.

Single + batch text embeddings and a cosine-similarity comparison.

`embed` is a generated request-reply method: it takes a validated
`EmbedRequest` and returns an `EmbedResponse` (there's no flat `embed(text=)`
convenience wrapper yet). Request models are re-exported from the flat surface,
so `from tetherto.qvac_sdk import EmbedRequest`.

RUN: python examples/embeddings.py
"""

from __future__ import annotations

import asyncio
import math
import sys

from _common import print_progress

from tetherto.qvac_sdk import Client, EmbedRequest, embed, load_model, unload_model
from tetherto.qvac_sdk.models import EMBEDDINGGEMMA_300M_Q4_0


def cosine_similarity(a, b) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb)


async def embed_text(t, model_id, text):
    response = await embed(
        t,
        EmbedRequest.model_validate(
            {"type": "embed", "modelId": model_id, "text": text}
        ),
    )
    if not response.success:
        raise RuntimeError(response.error)
    return response.embedding


async def main() -> int:
    async with Client() as client:
        t = client.transport
        try:
            model_id = await load_model(
                t, model_src=EMBEDDINGGEMMA_300M_Q4_0, on_progress=print_progress
            )

            print("\n▸ Example 1: Single Text Embedding")
            print("=" * 50)
            single = await embed_text(t, model_id, "Hello, world!")
            print("Input: 'Hello, world!'")
            print("Embedding dimensions:", len(single))
            print("First 10 values:", single[:10])

            print("\n▸ Example 2: Batch Text Embeddings")
            print("=" * 50)
            texts = [
                "The quick brown fox jumps over the lazy dog",
                "A fast auburn fox leaps over a sleepy canine",
                "Python is a programming language",
            ]
            batch = await embed_text(t, model_id, texts)
            print("Input: Array of", len(texts), "texts")
            print("Output: Array of", len(batch), "embeddings")
            emb1, emb2, emb3 = batch
            print("Each embedding dimensions:", len(emb1))

            print("\n▸ Similarity Analysis")
            print("=" * 50)
            print(
                "Similarity between texts 1 and 2 (similar meaning):",
                f"{cosine_similarity(emb1, emb2):.4f}",
            )
            print(
                "Similarity between texts 1 and 3 (different topics):",
                f"{cosine_similarity(emb1, emb3):.4f}",
            )
            print("\n▸ Higher values indicate more similar meanings")

            await unload_model(t, model_id)
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
