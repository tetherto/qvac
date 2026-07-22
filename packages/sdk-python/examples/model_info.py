"""Python port of packages/sdk/examples/cache-management.ts.

Inspect a model's cache/load state, download it if missing, load, unload, and
re-inspect. `get_model_info` and `download_asset_with_progress` are generated
methods; `load_model`/`unload_model` are the ergonomic wrappers. Request models
are re-exported from the flat surface.

RUN: python examples/model_info.py
"""

from __future__ import annotations

import asyncio
import sys

from _common import print_progress

from tetherto.qvac_sdk import (
    Client,
    DownloadAssetRequest,
    GetModelInfoRequest,
    ModelProgressResponse,
    download_asset_with_progress,
    get_model_info,
    load_model,
    unload_model,
)
from tetherto.qvac_sdk.models import WHISPER_TINY

MB = 1024 * 1024


def print_status(info, label) -> None:
    print(f"\n▸ {label}")
    print(f"▸ Model Name: {info.name}")
    print(f"▸ Model ID: {info.model_id}")
    print(f"▸ Expected Size: {info.expected_size / MB:.2f} MB")
    print(f"▸ Addon: {info.addon}")
    print(f"▸ Cache Files: {len(info.cache_files or [])}")
    print(f"▸ Is Cached: {'yes' if info.is_cached else 'no'}")
    print(f"▸ Is Loaded: {'yes' if info.is_loaded else 'no'}")
    if info.is_cached and info.actual_size is not None:
        print(f"▸ Actual Size: {info.actual_size / MB:.2f} MB")


async def fetch_info(t):
    response = await get_model_info(
        t,
        GetModelInfoRequest.model_validate(
            {"type": "getModelInfo", "name": WHISPER_TINY.name}
        ),
    )
    return response.model_info


async def main() -> int:
    async with Client() as client:
        t = client.transport
        try:
            print("▸ Model Info + Cache Management Demo")

            print("\n▸ 1. INITIAL STATUS CHECK")
            initial = await fetch_info(t)
            print_status(initial, "Initial Status:")

            if not initial.is_cached:
                print("\n▸ 2. DOWNLOADING MODEL (not cached)")
                request = DownloadAssetRequest.model_validate(
                    {"type": "downloadAsset", "assetSrc": WHISPER_TINY.src}
                )
                async for event in download_asset_with_progress(t, request):
                    if isinstance(event, ModelProgressResponse):
                        print_progress(event)
                print("▸ Download complete!")
                print_status(await fetch_info(t), "Status After Download:")
            else:
                print("\n▸ 2. MODEL ALREADY CACHED — skipping download")

            print("\n▸ 3. LOADING MODEL INTO MEMORY")
            model_id = await load_model(t, model_src=WHISPER_TINY)
            print(f"▸ Model loaded! ID: {model_id}")
            print_status(await fetch_info(t), "Status After Load:")

            print("\n▸ 4. UNLOADING MODEL")
            await unload_model(t, model_id)
            print("▸ Model unloaded!")
            print_status(await fetch_info(t), "Status After Unload:")

            print("\n▸ Demo Complete")
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
