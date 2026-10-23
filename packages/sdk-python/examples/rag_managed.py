"""Python port of packages/sdk/examples/rag/rag-hyperdb/ingest.ts.

Ingest documents into a built-in RAG workspace and query them with similarity
search, without setting up an external vector DB.

`rag` is a generated request-reply method covering every RAG operation: it
takes a `RagRequest` discriminated by `operation` and returns a `RagResponse`
(there are no flat `rag_ingest()` / `rag_search()` wrappers like the JS SDK's).
Both models are re-exported from the flat surface, and each is a union, so the
operation's own payload sits on the response's `.root`.

RUN: python examples/rag_managed.py [query]
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import Client, RagRequest, load_model, rag, unload_model
from tetherto.qvac_sdk.models import GTE_LARGE_FP16


def print_progress(p) -> None:
    """Print model download progress; pass as `on_progress=` to `load_model`."""
    line = (
        f"▸ Downloading {p.percentage:.0f}% "
        f"({p.downloaded / 1e6:.1f}/{p.total / 1e6:.1f} MB)"
    )
    print(line, end="\r" if sys.stderr.isatty() else "\n", file=sys.stderr)
    if p.percentage >= 100:
        print(file=sys.stderr)


async def main() -> int:
    async with Client() as client:
        t = client.transport
        try:
            # Get query from command line or use default
            query = sys.argv[1] if len(sys.argv) > 1 else "machine learning algorithms"
            workspace = "ingest-example"

            print(f'▸ Query: "{query}"')
            model_id = await load_model(
                t, model_src=GTE_LARGE_FP16, on_progress=print_progress
            )

            samples = [
                "Machine learning is a subset of artificial intelligence that focuses on algorithms that can learn and make predictions from data without being explicitly programmed for every task.",
                "Deep learning uses neural networks with multiple layers to process and learn from complex data patterns, enabling breakthroughs in image recognition and natural language processing.",
                "Natural language processing combines computational linguistics with machine learning to help computers understand, interpret, and generate human language in a meaningful way.",
                "Computer vision enables machines to interpret and understand visual information from the world, using techniques like image classification, object detection, and facial recognition.",
                "Quantum computing leverages quantum mechanical phenomena to process information in fundamentally different ways than classical computers, potentially solving certain problems exponentially faster.",
                "Blockchain technology creates decentralized, immutable ledgers that enable secure peer-to-peer transactions without requiring a central authority or intermediary.",
                "Cloud computing delivers computing services over the internet, allowing users to access resources like storage, processing power, and applications on-demand from anywhere.",
                "Cybersecurity protects digital systems, networks, and data from malicious attacks, unauthorized access, and various forms of cyber threats through multiple layers of defense.",
            ]

            print("▸ Ingesting documents...")
            ingest = await rag(
                t,
                RagRequest.model_validate(
                    {
                        "type": "rag",
                        "operation": "ingest",
                        "modelId": model_id,
                        "workspace": workspace,
                        "documents": samples,
                        "chunk": False,
                    }
                ),
            )
            if not ingest.root.success:
                raise RuntimeError(ingest.root.error)
            print(f"▸ Ingested {len(ingest.root.processed)} documents")

            print("▸ Searching for similar documents...")
            search = await rag(
                t,
                RagRequest.model_validate(
                    {
                        "type": "rag",
                        "operation": "search",
                        "modelId": model_id,
                        "workspace": workspace,
                        "query": query,
                        "topK": 3,
                    }
                ),
            )
            if not search.root.success:
                raise RuntimeError(search.root.error)

            print("▸ Top 3 most similar documents:")
            for index, result in enumerate(search.root.results, start=1):
                print(f"{index}. (Score: {result.score})")
                print(f"   {result.content}")
                print()

            # Cleanup: close and delete workspace
            close = await rag(
                t,
                RagRequest.model_validate(
                    {
                        "type": "rag",
                        "operation": "closeWorkspace",
                        "workspace": workspace,
                        "deleteOnClose": True,
                    }
                ),
            )
            if not close.root.success:
                raise RuntimeError(close.root.error)
            print(f"▸ Deleted '{workspace}' workspace")

            await unload_model(t, model_id)
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
