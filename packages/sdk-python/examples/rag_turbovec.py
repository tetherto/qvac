"""Python port of packages/sdk/examples/rag/rag-turbovec.ts.

Retrieval over documents kept in your own store. The SDK holds only the
vectors, in a TurboVec index inside the worker; the documents stay in this dict
(or any database you choose) and result ids map back to them.

`vector_index` is a generated request-reply method covering every index
operation. Where the JS SDK hands back an index object with `add`/`search`/
`write`/`dispose` methods, `create` here returns an `indexId` that every later
operation carries. `search` is batched: it takes `queries` and returns one
result list per query. `VectorIndexStorage` is a plain enum, so pass its
`.value` — the wire contract takes the string.

RUN: python examples/rag_turbovec.py [query]
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import (
    Client,
    EmbedRequest,
    VectorIndexRequest,
    VectorIndexStorage,
    embed,
    load_model,
    unload_model,
    vector_index,
)
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
    async with Client() as client:
        t = client.transport
        try:
            query = (
                sys.argv[1]
                if len(sys.argv) > 1
                else "Which moon has methane rain and lakes?"
            )
            print(f'▸ Query: "{query}"')

            # Ids are numeric by contract, so keep your own id as the key and
            # let the index hold only the numeric handle plus the vector.
            documents = {
                "1": "Saturn moon Titan has lakes, clouds, and rain made of liquid methane.",
                "2": "Solar panels convert sunlight into electricity using photovoltaic cells.",
                "3": "Honeybees communicate the location of flowers through a waggle dance.",
                "4": "The Pacific Ocean is the largest and deepest ocean on Earth.",
            }

            model_id = await load_model(
                t, model_src=GTE_LARGE_FP16, on_progress=print_progress
            )

            print("▸ Embedding documents...")
            vectors = await embed_text(t, model_id, list(documents.values()))

            print("▸ Building the vector index...")
            created = await vector_index(
                t,
                VectorIndexRequest.model_validate(
                    {
                        "type": "vectorIndex",
                        "operation": "create",
                        "dim": len(vectors[0]),
                        "storage": VectorIndexStorage.turbovec_q4.value,
                    }
                ),
            )
            index_id = created.root.index_id
            added = await vector_index(
                t,
                VectorIndexRequest.model_validate(
                    {
                        "type": "vectorIndex",
                        "operation": "add",
                        "indexId": index_id,
                        "ids": list(documents.keys()),
                        "vectors": vectors,
                    }
                ),
            )
            print(
                f"▸ Indexed {added.root.length} vectors of dimension {created.root.dim}"
            )

            print("▸ Searching...")
            query_vector = await embed_text(t, model_id, query)
            found = await vector_index(
                t,
                VectorIndexRequest.model_validate(
                    {
                        "type": "vectorIndex",
                        "operation": "search",
                        "indexId": index_id,
                        "queries": [query_vector],
                        "k": 2,
                    }
                ),
            )
            hits = found.root.results[0]
            print("▸ Top matches:")
            for hit in hits:
                print(f"  score={hit.score:.4f} id={hit.id}: {documents[hit.id]}")

            # Snapshots persist the vectors only. A relative path resolves under
            # the QVAC data directory; pass an absolute path to store it elsewhere.
            snapshot_path = "examples/rag_turbovec.qvi"
            written = await vector_index(
                t,
                VectorIndexRequest.model_validate(
                    {
                        "type": "vectorIndex",
                        "operation": "write",
                        "indexId": index_id,
                        "path": snapshot_path,
                    }
                ),
            )
            await vector_index(
                t,
                VectorIndexRequest.model_validate(
                    {
                        "type": "vectorIndex",
                        "operation": "dispose",
                        "indexId": index_id,
                    }
                ),
            )
            print(f"▸ Snapshot written to {written.root.path}")

            reloaded = await vector_index(
                t,
                VectorIndexRequest.model_validate(
                    {
                        "type": "vectorIndex",
                        "operation": "load",
                        "path": snapshot_path,
                    }
                ),
            )
            reloaded_id = reloaded.root.index_id
            reloaded_found = await vector_index(
                t,
                VectorIndexRequest.model_validate(
                    {
                        "type": "vectorIndex",
                        "operation": "search",
                        "indexId": reloaded_id,
                        "queries": [query_vector],
                        "k": 1,
                    }
                ),
            )
            reloaded_hits = reloaded_found.root.results[0]
            reloaded_best = reloaded_hits[0] if reloaded_hits else None
            await vector_index(
                t,
                VectorIndexRequest.model_validate(
                    {
                        "type": "vectorIndex",
                        "operation": "dispose",
                        "indexId": reloaded_id,
                    }
                ),
            )
            best = hits[0] if hits else None
            if reloaded_best is None or best is None or reloaded_best.id != best.id:
                raise RuntimeError(
                    f"Reloaded index returned id="
                    f"{reloaded_best.id if reloaded_best else None} but the "
                    f"original returned id={best.id if best else None}"
                )
            print(f"▸ Reloaded index agrees: best match id={reloaded_best.id}")

            await unload_model(t, model_id)
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
