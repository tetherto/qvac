"""Python port of packages/sdk/examples/rag/rag-turbovec-ivf.ts.

IVF search over documents kept in your own store. setIvf() groups the vectors
into lists, and each search scans only the lists nearest the query. On a large
F32 index that can be many times faster than a full scan, while on TurboVec
storage it can be slower. This example uses F32 storage with 16 documents, so
it shows the API rather than the speedup.

`vector_index` is a generated request-reply method covering every index
operation; `create` returns an `indexId` that every later operation carries.
There is no index object holding the IVF state, so read it off the `ivf` field
of the `setIvf` and `add` responses. `search` is batched: it takes `queries`
and returns one result list per query.

RUN: python examples/rag_turbovec_ivf.py [query]
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

            documents = {
                "1": "Saturn moon Titan has lakes, clouds, and rain made of liquid methane.",
                "2": "Jupiter moon Europa hides a salty ocean under a shell of ice.",
                "3": "Mars has the tallest volcano in the solar system, Olympus Mons.",
                "4": "Venus is the hottest planet because its thick air traps heat.",
                "5": "Solar panels convert sunlight into electricity using photovoltaic cells.",
                "6": "Wind turbines turn the motion of air into electrical power.",
                "7": "Lithium-ion batteries store energy for phones and electric cars.",
                "8": "Hydroelectric dams generate power from water flowing downhill.",
                "9": "Honeybees communicate the location of flowers through a waggle dance.",
                "10": "Octopuses can change the color and texture of their skin in an instant.",
                "11": "Arctic terns migrate from pole to pole every year.",
                "12": "Elephants recognize themselves in a mirror.",
                "13": "The Pacific Ocean is the largest and deepest ocean on Earth.",
                "14": "Coral reefs grow from colonies of tiny animals called polyps.",
                "15": "Ocean tides rise and fall with the pull of the Moon.",
                "16": "The Mariana Trench reaches nearly eleven kilometers below sea level.",
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
                        "storage": VectorIndexStorage.f32.value,
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

            query_vector = await embed_text(t, model_id, query)
            # A full scan before IVF is on, to check the probed results against.
            full_found = await vector_index(
                t,
                VectorIndexRequest.model_validate(
                    {
                        "type": "vectorIndex",
                        "operation": "search",
                        "indexId": index_id,
                        "queries": [query_vector],
                        "k": 1,
                    }
                ),
            )
            full_hits = full_found.root.results[0]
            full_best = full_hits[0] if full_hits else None

            # Four lists, one probed per search: each query scans about a
            # quarter of the index. A higher nProbe finds more true neighbours
            # and costs more.
            print("▸ Building IVF lists...")
            ivf_set = await vector_index(
                t,
                VectorIndexRequest.model_validate(
                    {
                        "type": "vectorIndex",
                        "operation": "setIvf",
                        "indexId": index_id,
                        "ivf": {"nLists": 4, "nProbe": 1},
                    }
                ),
            )
            ivf = ivf_set.root.ivf
            if ivf is None or not ivf.built:
                raise RuntimeError("setIvf did not build the IVF lists")
            print(f"▸ IVF on: {ivf.n_lists} lists, {ivf.n_probe} probed per search")

            print("▸ Searching...")
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

            # nProbe on one call overrides the setting for that call only.
            # Probing every list scans the whole index, so it agrees with the
            # full scan.
            wider_found = await vector_index(
                t,
                VectorIndexRequest.model_validate(
                    {
                        "type": "vectorIndex",
                        "operation": "search",
                        "indexId": index_id,
                        "queries": [query_vector],
                        "k": 1,
                        "nProbe": ivf.n_lists,
                    }
                ),
            )
            wider_hits = wider_found.root.results[0]
            wider_best = wider_hits[0] if wider_hits else None
            if wider_best is None or full_best is None or wider_best.id != full_best.id:
                raise RuntimeError(
                    f"Probing every list returned id="
                    f"{wider_best.id if wider_best else None} but the full scan "
                    f"returned id={full_best.id if full_best else None}"
                )
            print(
                f"▸ Probing all {ivf.n_lists} lists agrees with the full scan: "
                f"id={wider_best.id}"
            )

            # An add makes the lists stale. Search scans every vector until
            # setIvf builds them again.
            extra = "Neptune has the fastest winds of any planet in the solar system."
            extra_vector = await embed_text(t, model_id, extra)
            added_extra = await vector_index(
                t,
                VectorIndexRequest.model_validate(
                    {
                        "type": "vectorIndex",
                        "operation": "add",
                        "indexId": index_id,
                        "ids": ["17"],
                        "vectors": [extra_vector],
                    }
                ),
            )
            documents["17"] = extra
            stale = added_extra.root.ivf
            print(
                f"▸ Added a document; IVF lists built: {stale.built if stale else None}"
            )
            rebuilt = await vector_index(
                t,
                VectorIndexRequest.model_validate(
                    {
                        "type": "vectorIndex",
                        "operation": "setIvf",
                        "indexId": index_id,
                        "ivf": {"nLists": 4, "nProbe": 1},
                    }
                ),
            )
            fresh = rebuilt.root.ivf
            print(f"▸ Rebuilt the IVF lists; built: {fresh.built if fresh else None}")

            # None turns IVF off, and search scans every vector again.
            ivf_off = await vector_index(
                t,
                VectorIndexRequest.model_validate(
                    {
                        "type": "vectorIndex",
                        "operation": "setIvf",
                        "indexId": index_id,
                        "ivf": None,
                    }
                ),
            )
            print(f"▸ IVF off: {ivf_off.root.ivf is None}")

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
            await unload_model(t, model_id)
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
