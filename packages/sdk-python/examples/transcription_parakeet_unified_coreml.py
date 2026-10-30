"""Python port of packages/sdk/examples/asr/parakeet-unified-coreml.ts.

Transcribe a WAV file with Parakeet Unified and its Core ML encoder sidecar
(macOS only). The GGUF must be a regenerated Unified artifact. The five
compiled Core ML files are downloaded through the SDK registry and staged
beside the GGUF in a temporary directory, which is removed afterwards.

TypeScript's `transcribe()` returns the joined text. Python calls the worker
directly, so `transcribe` yields `TranscribeResponse` frames and the example
joins their `text` itself. `get_model_info` and `download_asset` are generated
stubs, so each takes its request model.

RUN: python examples/transcription_parakeet_unified_coreml.py <regenerated-unified-gguf> <16-kHz-wav-file>
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

from tetherto.qvac_sdk import (
    Client,
    DownloadAssetRequest,
    GetModelInfoRequest,
    TranscribeRequest,
    download_asset,
    get_model_info,
    load_model,
    transcribe,
    unload_model,
)

MODEL_STEM = "parakeet-unified-en-0.6b"
COREML_FILES = [
    ("PARAKEET_UNIFIED_COREMLDATA", "analytics/coremldata.bin"),
    ("PARAKEET_UNIFIED_COREMLDATA_1", "coremldata.bin"),
    ("PARAKEET_UNIFIED_METADATA", "metadata.json"),
    ("PARAKEET_UNIFIED_MODEL", "model.mil"),
    ("PARAKEET_UNIFIED_WEIGHT", "weights/weight.bin"),
]


def check_model(path: Path) -> None:
    if not re.fullmatch(
        r"parakeet-unified-en-0\.6b\.(?:f16|q4_0|q8_0)\.gguf", path.name
    ):
        raise ValueError(f"Expected a regenerated Unified GGUF, got: {path.name}")

    with path.open("rb") as file:
        header = file.read(1024 * 1024)
    if b"parakeet.unified.left_context_frames" not in header:
        raise ValueError(f"Unified GGUF lacks the new streaming metadata: {path}")


async def fetch_info(t, name: str):
    request = GetModelInfoRequest.model_validate({"type": "getModelInfo", "name": name})
    return (await get_model_info(t, request)).model_info


async def stage_model(t, path: Path) -> tuple[str, Path]:
    if sys.platform != "darwin":
        raise RuntimeError("Core ML requires macOS")
    check_model(path)

    staging_dir = Path(tempfile.mkdtemp(prefix="qvac-unified-coreml-"))
    try:
        model_src = staging_dir / path.name
        model_src.symlink_to(path.resolve())
        bundle_dir = staging_dir / f"{MODEL_STEM}-encoder.mlmodelc"

        for name, relative_path in COREML_FILES:
            info = await fetch_info(t, name)
            if not info.is_cached:
                if not info.registry_source or not info.registry_path:
                    raise RuntimeError(f"Registry location missing for {name}")
                print(f"▸ Downloading Core ML {relative_path}...")
                request = DownloadAssetRequest.model_validate(
                    {
                        "type": "downloadAsset",
                        "assetSrc": f"registry://{info.registry_source}/{info.registry_path}",
                    }
                )
                await download_asset(t, request)

            cached = await fetch_info(t, name)
            source_path = next(
                (file.path for file in cached.cache_files or [] if file.is_cached), None
            )
            if not source_path:
                raise RuntimeError(
                    f"Core ML file is missing from the SDK cache: {name}"
                )

            target_path = bundle_dir / relative_path
            target_path.parent.mkdir(parents=True, exist_ok=True)
            os.link(source_path, target_path)

        return str(model_src), staging_dir
    except BaseException:
        shutil.rmtree(staging_dir, ignore_errors=True)
        raise


async def main() -> int:
    if len(sys.argv) < 3:
        print(
            "Usage: python examples/transcription_parakeet_unified_coreml.py "
            "<regenerated-unified-gguf> <16-kHz-wav-file>",
            file=sys.stderr,
        )
        return 1
    model_path = Path(sys.argv[1])
    audio_path = sys.argv[2]

    async with Client() as client:
        t = client.transport
        staging_dir = None
        model_id = None
        try:
            model_src, staging_dir = await stage_model(t, model_path)
            print("▸ Loading Parakeet Unified with its Core ML encoder sidecar...")
            model_id = await load_model(
                t,
                model_src=model_src,
                model_type="parakeet-transcription",
                model_config={"useGPU": True},
            )

            print("▸ Transcribing audio...")
            # audioChunk is a typed chunk, not a bare path: JS's transcribe
            # wrapper turns a string into {type:"filePath"} for you, but Python
            # calls the generated stub directly, so build the chunk explicitly.
            request = TranscribeRequest.model_validate(
                {
                    "type": "transcribe",
                    "modelId": model_id,
                    "audioChunk": {"type": "filePath", "value": audio_path},
                }
            )

            text = ""
            async for response in transcribe(t, request):
                if response.text:
                    text += response.text

            if not text.strip():
                raise RuntimeError("Parakeet Unified returned an empty transcription")
            print(text)
        except Exception as error:
            print(f"✖ {error}", file=sys.stderr)
            return 1
        finally:
            try:
                if model_id is not None:
                    await unload_model(t, model_id)
            finally:
                if staging_dir is not None:
                    shutil.rmtree(staging_dir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
