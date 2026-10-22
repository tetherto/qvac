"""Python port of packages/sdk/examples/diffusion-img2vid-minimax-h3.ts.

Image-to-video with MiniMax-H3, using the same diffusion + Qwen3-VL + video
VAE layout as H3 text-to-video; no CLIP-vision encoder is needed. The audio
VAE is omitted for silent output -- add `audioVaeModelSrc` when loading the
model to generate synchronized 32 kHz audio. The three files are read from a
local directory you pass as argv, so nothing is downloaded.

This example needs powerful hardware. `offload_to_cpu` stays on so the run
fits on a single GPU; tune placement through the H3_* environment variables.

TypeScript's `video()` takes `init_image` as raw bytes and base64-encodes them
on the way to the worker. Python calls the worker directly through
`video_stream`, where `init_image` is already the encoded string, so the
example encodes the file itself. The same iterator then carries progress, the
finished clips and the closing stats, which TypeScript receives as three
separate channels.

RUN: python examples/diffusion_img2vid_minimax_h3.py <models-directory> <init-image> [output.avi]
"""

from __future__ import annotations

import asyncio
import base64
import os
import sys
from pathlib import Path
from typing import Any

from tetherto.qvac_sdk import (
    Client,
    VideoStreamRequest,
    load_model,
    unload_model,
    video_stream,
)

DEFAULT_PROMPT = (
    "The boat glides forward through the mist while the camera slowly pulls "
    "back, cinematic natural motion."
)


async def main() -> int:
    models_dir = sys.argv[1] if len(sys.argv) > 1 else None
    init_image_path = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    if not models_dir or not init_image_path:
        print("✖ models directory and init image path are required", file=sys.stderr)
        print(
            "Usage: python examples/diffusion_img2vid_minimax_h3.py "
            "<modelsDirectory> <initImagePath> [output.avi]",
            file=sys.stderr,
        )
        return 1

    output_path = (
        Path(sys.argv[3]) if len(sys.argv) > 3 else Path("minimax-h3-img2vid.avi")
    )
    root = Path(models_dir).resolve()
    model_src = root / os.environ.get("H3_MODEL", "minimax_h3_fl2va_pruned-Q4_K.gguf")
    llm_model_src = root / os.environ.get(
        "H3_LLM", "qwen3vl_32b_minimax_h3-Q4_K_M.gguf"
    )
    vae_model_src = root / "vae/minimax_h3_video_vae_fp16.safetensors"
    for file in (model_src, llm_model_src, vae_model_src, init_image_path):
        if not file.is_file():
            print(f"✖ missing model file: {file}", file=sys.stderr)
            return 1

    model_config: dict[str, Any] = {
        "mode": "video",
        "llmModelSrc": str(llm_model_src),
        "vaeModelSrc": str(vae_model_src),
        "device": "gpu",
        "diffusion_fa": True,
        "offload_to_cpu": os.environ.get("H3_OFFLOAD_TO_CPU") != "0",
        "stream_layers": os.environ.get("H3_STREAM_LAYERS") == "1",
    }
    for key, variable in (
        ("backend", "H3_BACKEND"),
        ("params_backend", "H3_PARAMS_BACKEND"),
        ("max_vram", "H3_MAX_VRAM"),
    ):
        value = os.environ.get(variable)
        if value:
            model_config[key] = value

    model_id = None
    try:
        async with Client() as client:
            t = client.transport
            try:
                print(
                    "▸ Loading MiniMax-H3 model "
                    "(diffusion + Qwen3-VL + video VAE)..."
                )
                model_id = await load_model(
                    t,
                    model_src=str(model_src),
                    model_type="sdcpp-generation",
                    model_config=model_config,
                )
                print(f"▸ Model loaded: {model_id}")

                init_image = base64.b64encode(init_image_path.read_bytes()).decode(
                    "ascii"
                )
                prompt = os.environ.get("PROMPT") or DEFAULT_PROMPT
                print(f'▸ Generating video for: "{prompt}"')

                request = VideoStreamRequest.model_validate(
                    {
                        "type": "videoStream",
                        "modelId": model_id,
                        "mode": "img2vid",
                        "prompt": prompt,
                        "init_image": init_image,
                        "width": 864,
                        "height": 480,
                        # H3 uses 17*k+5 frames and requires 24 FPS.
                        "video_frames": int(os.environ.get("FRAMES") or 124),
                        "fps": 24,
                        "steps": 8,
                        "cfg_scale": 1,
                        "seed": 11,
                    }
                )

                clips: list[bytes] = []
                stats = None
                async for response in video_stream(t, request):
                    if response.step is not None and response.total_steps is not None:
                        print(f"▸ step {response.step:.0f}/{response.total_steps:.0f}")
                    if response.data is not None:
                        clips.append(base64.b64decode(response.data))
                    if response.done:
                        stats = response.stats

                if not clips:
                    raise RuntimeError("Generation finished without an AVI result")
                output_path.write_bytes(clips[0])
                print(
                    f"▸ Saved {output_path}",
                    stats.model_dump(exclude_none=True) if stats else None,
                )
            finally:
                if model_id:
                    await unload_model(t, model_id, clear_storage=False)
    except Exception as error:
        print("✖", error, file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
