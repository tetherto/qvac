"""Python port of packages/sdk/examples/rag/rag-sqlite.ts.

Keep each document in SQLite alongside its vector and retrieve matches with
the SQLite-Vector extension's quantized scan. QVAC only produces the vectors
through `embed`; the storage, quantization and search all happen in SQL.

The extension and its SQL are the same ones the TypeScript example uses, but
they arrive differently. There the npm `@sqliteai/sqlite-wasm` build has the
extension compiled in; here the stdlib `sqlite3` module loads a prebuilt
binary, shipped by `pip install sqliteai-vector`. That needs an interpreter
configured with `--enable-loadable-sqlite-extensions`, which pyenv's default
build is not (`sqlite3.Connection.enable_load_extension` is absent when it is
missing), so this example checks for it before trying.

RUN: python examples/rag_sqlite.py [query]
"""

from __future__ import annotations

import asyncio
import importlib.resources
import json
import sqlite3
import sys

from tetherto.qvac_sdk import Client, EmbedRequest, embed, load_model, unload_model
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


async def embed_text(t, model_id, text):
    """Embed one string or a list of strings; returns the vector(s)."""
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
    # Get query from command line or use default
    query = sys.argv[1] if len(sys.argv) > 1 else "machine learning algorithms"
    print(f'▸ Query: "{query}"')

    # Initialize SQLite with vector extension
    db = sqlite3.connect(":memory:")
    if not hasattr(db, "enable_load_extension"):
        print(
            "✖ This Python cannot load SQLite extensions, so the vector "
            "extension is unavailable",
            file=sys.stderr,
        )
        print(
            "▸ Nothing is missing from your environment: the interpreter itself "
            "must be built with --enable-loadable-sqlite-extensions. Most "
            "distribution and python.org builds are; pyenv's default build is not",
            file=sys.stderr,
        )
        return 1

    try:
        extension = importlib.resources.files("sqlite_vector.binaries") / "vector"
    except ModuleNotFoundError:
        print(
            "✖ This example needs the SQLite vector extension: "
            "pip install sqliteai-vector",
            file=sys.stderr,
        )
        return 1

    db.enable_load_extension(True)
    db.load_extension(str(extension))
    db.enable_load_extension(False)

    try:
        async with Client() as client:
            t = client.transport
            model_id = await load_model(
                t, model_src=GTE_LARGE_FP16, on_progress=print_progress
            )

            samples = [
                {
                    "id": 1,
                    "text": "Machine learning is a subset of artificial intelligence that focuses on algorithms that can learn and make predictions from data without being explicitly programmed for every task.",
                },
                {
                    "id": 2,
                    "text": "Deep learning uses neural networks with multiple layers to process and learn from complex data patterns, enabling breakthroughs in image recognition and natural language processing.",
                },
                {
                    "id": 3,
                    "text": "Natural language processing combines computational linguistics with machine learning to help computers understand, interpret, and generate human language in a meaningful way.",
                },
                {
                    "id": 4,
                    "text": "Computer vision enables machines to interpret and understand visual information from the world, using techniques like image classification, object detection, and facial recognition.",
                },
                {
                    "id": 5,
                    "text": "Quantum computing leverages quantum mechanical phenomena to process information in fundamentally different ways than classical computers, potentially solving certain problems exponentially faster.",
                },
                {
                    "id": 6,
                    "text": "Blockchain technology creates decentralized, immutable ledgers that enable secure peer-to-peer transactions without requiring a central authority or intermediary.",
                },
                {
                    "id": 7,
                    "text": "Cloud computing delivers computing services over the internet, allowing users to access resources like storage, processing power, and applications on-demand from anywhere.",
                },
                {
                    "id": 8,
                    "text": "Cybersecurity protects digital systems, networks, and data from malicious attacks, unauthorized access, and various forms of cyber threats through multiple layers of defense.",
                },
            ]

            # Create table for documents with vector storage
            db.execute("""
                CREATE TABLE IF NOT EXISTS documents (
                  id INTEGER PRIMARY KEY,
                  text TEXT NOT NULL,
                  embedding BLOB NOT NULL
                )
            """)

            print("▸ Embedding documents...")
            for sample in samples:
                embedding = await embed_text(t, model_id, sample["text"])
                db.execute(
                    "INSERT INTO documents VALUES (?, ?, vector_as_f32(?))",
                    (sample["id"], sample["text"], json.dumps(embedding)),
                )

            # Initialize and optimize vector index
            db.execute(
                "SELECT vector_init('documents', 'embedding', ?)",
                ("type=FLOAT32,dimension=1024",),
            )

            # Quantize vectors
            db.execute("SELECT vector_quantize('documents', 'embedding')")

            # [Optional] Preload quantized vectors in memory for optimal performance
            db.execute("SELECT vector_quantize_preload('documents', 'embedding')")

            # Search for similar documents
            print("▸ Searching for similar documents...")
            query_embedding = await embed_text(t, model_id, query)

            # Perform vector search. The scan returns only rowid and distance,
            # so the table is self-joined to read the text back.
            results = db.execute(
                """
                SELECT d.id, d.text, v.distance
                FROM documents d
                JOIN vector_quantize_scan('documents', 'embedding', vector_as_f32(?), 3) v
                ON d.id = v.rowid
                """,
                (json.dumps(query_embedding),),
            ).fetchall()

            print("\n▸ Top 3 most similar documents:")
            for index, (doc_id, text, distance) in enumerate(results, start=1):
                print("=" * 50 + " Top result:")
                print(f"\n{index}. [ID: {doc_id}] (Score: {distance:.4f})")
                print(f"   {text}")
                print("=" * 100)
                print()

            await unload_model(t, model_id)
    except Exception as error:
        print(f"✖ {error}", file=sys.stderr)
        return 1
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
