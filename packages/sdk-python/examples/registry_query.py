"""Python port of packages/sdk/examples/registry-query.ts.

Query the QVAC model registry: list, filter, search by engine / quantization /
addon, and fetch one model's full record. These are request-reply methods on
the flat `tetherto.qvac_sdk` surface; no model needs to be loaded, but a running worker (the
transport) is required.

RUN: python examples/registry_query.py
"""

from __future__ import annotations

import asyncio
import sys

from tetherto.qvac_sdk import (
    Client,
    model_registry_get_model,
    model_registry_list,
    model_registry_search,
)


def val(x):
    """Registry enum fields (addon/engine) are pydantic enums; render the wire
    string, matching the JS SDK's plain-string fields."""
    return x.value if hasattr(x, "value") else x


def format_size(n) -> str:
    if n < 1024:
        return f"{n}B"
    if n < 1024**2:
        return f"{n / 1024:.1f}KB"
    if n < 1024**3:
        return f"{n / 1024**2:.1f}MB"
    return f"{n / 1024**3:.1f}GB"


async def main() -> int:
    async with Client() as client:
        t = client.transport
        try:
            print("▸ QVAC Model Registry Query Examples\n")

            print("▸ Listing all models in QVAC model registry...")
            all_models = await model_registry_list(t)
            print(f"▸ Found {len(all_models)} models in registry\n")

            print("▸ Sample models:")
            for m in all_models[:5]:
                print(
                    f"   - {m.name} ({val(m.addon)}, {val(m.engine)}, {format_size(m.expected_size)})"
                )
            print()

            print('▸ Searching for "whisper" models...')
            whisper = await model_registry_search(t, filter="whisper")
            print(f"▸ Found {len(whisper)} whisper-related models\n")

            print("▸ Searching by engine (llamacpp-embedding)...")
            embed_models = await model_registry_search(t, engine="llamacpp-embedding")
            print(f"▸ Found {len(embed_models)} embedding models")
            for m in embed_models[:3]:
                print(f"   - {m.name} ({m.quantization})")
            print()

            print("▸ Searching for Q4 quantized models...")
            q4 = await model_registry_search(t, quantization="q4")
            print(f"▸ Found {len(q4)} Q4 quantized models")
            for m in q4[:3]:
                print(f"   - {m.name}")
            print()

            if all_models:
                sample = all_models[0]
                print(
                    f"▸ Getting specific model: {sample.registry_source}/{sample.registry_path}"
                )
                model = await model_registry_get_model(
                    t, sample.registry_path, sample.registry_source
                )
                print("   Model details:")
                print(f"   - Name: {model.name}")
                print(f"   - Addon: {val(model.addon)}")
                print(f"   - Engine: {val(model.engine)}")
                print(f"   - Quantization: {model.quantization}")
                print(f"   - Expected size: {format_size(model.expected_size)}")
                print()

            print("▸ QVAC model registry query examples completed successfully!")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
