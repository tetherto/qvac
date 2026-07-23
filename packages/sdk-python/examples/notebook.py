"""Notebook facade — the synchronous, data-science-native client.

`tetherto.qvac_sdk.notebook.SyncClient` wraps the async client on a background
event-loop thread so every call is a plain blocking call (no `await`), with
numpy/pandas-native returns and live in-cell streaming. It's the ergonomic way
to drive QVAC from a Jupyter notebook or a REPL.

Needs the `notebook` extra (numpy + pandas):
    pip install "tetherto-qvac-sdk[notebook,bare-rpc]"

RUN: python examples/notebook.py
"""

from __future__ import annotations

import sys

from tetherto.qvac_sdk.models import EMBEDDINGGEMMA_300M_Q4_0, QWEN3_600M_INST_Q4
from tetherto.qvac_sdk.notebook import SyncClient


def main() -> int:
    # SyncClient owns a Client (pass any Client kwargs, e.g. sdk_dir=...), or
    # wrap an already-connected transport with SyncClient(transport=...).
    # No async/await anywhere below -- a background thread runs the event loop.
    with SyncClient() as client:
        print("▸ Embeddings as numpy arrays")
        embed_model = client.load_model(model_src=EMBEDDINGGEMMA_300M_Q4_0)
        vector = client.embed(embed_model, "hello from the notebook facade")
        print(f"  one text  -> ndarray shape {vector.shape}, dtype {vector.dtype}")

        matrix = client.embed(embed_model, ["cats and dogs", "kittens and puppies"])
        print(f"  a batch   -> ndarray shape {matrix.shape}")

        print("\n▸ Batch embeddings as a pandas DataFrame (indexed by text)")
        frame = client.embed_frame(
            embed_model, ["quantum computing", "espresso machine", "qubit entanglement"]
        )
        print(f"  DataFrame {frame.shape}, index={list(frame.index)}")
        client.unload_model(embed_model)

        print("\n▸ Completion, streaming live into the cell/stdout")
        llm = client.load_model(
            model_src=QWEN3_600M_INST_Q4, model_config={"n_ctx": 2048}
        )
        text = client.completion(
            llm,
            "Explain what an embedding is in one sentence.",
            predict=256,
            temp=0,
            seed=42,
        )
        print(f"\n  returned {len(text)} chars")
        client.unload_model(llm)

    return 0


if __name__ == "__main__":
    sys.exit(main())
