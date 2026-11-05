"""Python port of packages/sdk/examples/rag/rag-mongodb.ts.

Store each document in MongoDB alongside its vector, build a vector search
index over it, and retrieve matches with a `$vectorSearch` aggregation that
pre-filters by category.

Needs the MongoDB driver (`pip install pymongo`) and a deployment with Atlas
Vector Search. QVAC only produces the vectors through `embed`; the storage,
indexing and search all belong to MongoDB.

The driver's asyncio API mirrors the JS one closely: `AsyncMongoClient`, and
every collection call awaited. Two differences worth knowing: `drop()` is
idempotent (the driver allows "ns not found"), so dropping a collection that
was never created needs no guard, and the index-build poll sleeps with
`asyncio.sleep` instead of a hand-rolled promise timer.

RUN: python examples/rag_mongodb.py [query] [category]
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import Client, EmbedRequest, embed, load_model, unload_model
from tetherto.qvac_sdk.models import GTE_LARGE_FP16

INDEX_NAME = "documents_vector_index"

MONGODB_SETUP_INSTRUCTIONS = """
▸ This example needs a MongoDB deployment with Atlas Vector Search.

One way to get one is to run it in Docker:

   docker run -p 27017:27017 --name atlas-local mongodb/mongodb-atlas-local

For more details, visit: https://www.mongodb.com/docs/atlas/cli/current/atlas-cli-deploy-docker/
"""


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
    try:
        from pymongo import AsyncMongoClient
        from pymongo.errors import PyMongoError
        from pymongo.operations import SearchIndexModel
    except ImportError:
        print("✖ This example needs pymongo: pip install pymongo", file=sys.stderr)
        return 1

    # Get query and category from command line or use defaults
    query = sys.argv[1] if len(sys.argv) > 1 else "machine learning algorithms"
    category = sys.argv[2] if len(sys.argv) > 2 else "ai"
    print(f'▸ Query: "{query}" (category: "{category}")')

    # Replace with your own deployment's connection string if it is not the Docker one
    # https://www.mongodb.com/docs/manual/reference/connection-string/
    mongo = AsyncMongoClient("mongodb://localhost:27017/?directConnection=true")
    try:
        await mongo.admin.command("ping")
        print("▸ Connected to MongoDB server")
    except PyMongoError:
        print("✖ Failed to connect to MongoDB server", file=sys.stderr)
        print(
            "▸ Please ensure the server is running on localhost:27017", file=sys.stderr
        )
        print(MONGODB_SETUP_INSTRUCTIONS, file=sys.stderr)
        await mongo.close()
        return 1

    collection = mongo["qvac"]["documents"]

    try:
        async with Client() as client:
            t = client.transport
            model_id = await load_model(
                t, model_src=GTE_LARGE_FP16, on_progress=print_progress
            )

            # Sample corpus, each document tagged with a category to filter on
            samples = [
                {
                    "id": 1,
                    "category": "ai",
                    "text": "Machine learning is a subset of artificial intelligence that focuses on algorithms that can learn and make predictions from data without being explicitly programmed for every task.",
                },
                {
                    "id": 2,
                    "category": "ai",
                    "text": "Deep learning uses neural networks with multiple layers to process and learn from complex data patterns, enabling breakthroughs in image recognition and natural language processing.",
                },
                {
                    "id": 3,
                    "category": "ai",
                    "text": "Natural language processing combines computational linguistics with machine learning to help computers understand, interpret, and generate human language in a meaningful way.",
                },
                {
                    "id": 4,
                    "category": "ai",
                    "text": "Computer vision enables machines to interpret and understand visual information from the world, using techniques like image classification, object detection, and facial recognition.",
                },
                {
                    "id": 5,
                    "category": "computing",
                    "text": "Quantum computing leverages quantum mechanical phenomena to process information in fundamentally different ways than classical computers, potentially solving certain problems exponentially faster.",
                },
                {
                    "id": 6,
                    "category": "security",
                    "text": "Blockchain technology creates decentralized, immutable ledgers that enable secure peer-to-peer transactions without requiring a central authority or intermediary.",
                },
                {
                    "id": 7,
                    "category": "computing",
                    "text": "Cloud computing delivers computing services over the internet, allowing users to access resources like storage, processing power, and applications on-demand from anywhere.",
                },
                {
                    "id": 8,
                    "category": "security",
                    "text": "Cybersecurity protects digital systems, networks, and data from malicious attacks, unauthorized access, and various forms of cyber threats through multiple layers of defense.",
                },
            ]

            # (Re)create the collection. The driver allows "ns not found", so
            # this is a no-op the first time round.
            await collection.drop()

            # Embed and store documents
            print("▸ Embedding documents...")
            documents = []
            for sample in samples:
                embedding = await embed_text(t, model_id, sample["text"])
                documents.append(
                    {
                        "id": sample["id"],
                        "category": sample["category"],
                        "text": sample["text"],
                        "embedding": embedding,
                    }
                )

            await collection.insert_many(documents)

            # numDimensions is fixed at index creation and must match the model:
            # GTE Large is 1024
            print("▸ Creating vector search index...")
            await collection.create_search_index(
                SearchIndexModel(
                    name=INDEX_NAME,
                    type="vectorSearch",
                    definition={
                        "fields": [
                            {
                                "type": "vector",
                                "path": "embedding",
                                "numDimensions": 1024,
                                "similarity": "cosine",
                            },
                            # A field must be indexed as a filter to be usable
                            # in a $vectorSearch filter
                            {"type": "filter", "path": "category"},
                        ]
                    },
                )
            )

            # Index builds are asynchronous; querying too early returns no matches
            for attempt in range(60):
                cursor = await collection.list_search_indexes(INDEX_NAME)
                indexes = await cursor.to_list()
                if indexes and indexes[0].get("queryable"):
                    break
                if attempt == 59:
                    raise RuntimeError(f"Index {INDEX_NAME} did not become queryable")
                await asyncio.sleep(1)

            print("▸ Searching for similar documents...")
            query_vector = await embed_text(t, model_id, query)

            cursor = await collection.aggregate(
                [
                    {
                        "$vectorSearch": {
                            "index": INDEX_NAME,
                            "path": "embedding",
                            "queryVector": query_vector,
                            "filter": {"category": {"$eq": category}},
                            "numCandidates": 100,
                            "limit": 3,
                        }
                    },
                    {
                        "$project": {
                            "_id": 0,
                            "id": 1,
                            "category": 1,
                            "text": 1,
                            "score": {"$meta": "vectorSearchScore"},
                        }
                    },
                ]
            )
            results = await cursor.to_list()

            print("▸ Top 3 most similar documents:")
            for index, result in enumerate(results, start=1):
                print(
                    f"{index}. (Score: {result['score']:.4f}, "
                    f"Category: {result['category']})"
                )
                print(f"   {result['text']}")
                print()

            await unload_model(t, model_id)
    except Exception as error:
        print(f"✖ {error}", file=sys.stderr)
        return 1
    finally:
        await mongo.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
