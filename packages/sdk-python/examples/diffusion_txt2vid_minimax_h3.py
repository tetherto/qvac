"""Python port of packages/sdk/examples/diffusion-txt2vid-minimax-h3.ts.

Text-to-video (+ synchronized 32 kHz audio) with MiniMax-H3, which uses a
split layout: a diffusion model, a Qwen3-VL text encoder, a video VAE and an
audio VAE. The four files are read from a local directory you pass as argv, so
nothing is downloaded.

This example needs powerful hardware. `offload_to_cpu` stays on so the run
fits on a single GPU; tune placement through the H3_* environment variables.

TypeScript's `video()` hands back three channels -- `progressStream`, `outputs`
and `stats` -- and the example drains the progress one concurrently with
`Promise.all`. Python exposes one async iterator that yields all three in
order, so the loop below needs no concurrency.

RUN: python examples/diffusion_txt2vid_minimax_h3.py <models-directory> [output.avi]
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
    "Premium cinematic coffee commercial. A confident adult sits at a small "
    "café table at sunrise, slowly lifts one matte black coffee cup, takes a "
    "relaxed sip, and smiles. Warm golden rim light, drifting steam, realistic "
    "skin, natural hands, shallow depth of field, subtle slow camera push-in, "
    "restrained natural motion, polished live-action advertising, no dialogue, "
    "no text overlay."
)


async def main() -> int:
    # Pass a directory containing the four MiniMax-H3 files, followed by an
    # output path.
    models_dir = sys.argv[1] if len(sys.argv) > 1 else None
    if not models_dir:
        print(
            "Usage: python examples/diffusion_txt2vid_minimax_h3.py "
            "<models-directory> [output.avi]",
            file=sys.stderr,
        )
        return 1

    output_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("minimax-h3.avi")
    root = Path(models_dir).resolve()
    model_src = root / os.environ.get("H3_MODEL", "minimax_h3_fl2va_pruned-Q4_K.gguf")
    llm_model_src = root / os.environ.get(
        "H3_LLM", "qwen3vl_32b_minimax_h3-Q4_K_M.gguf"
    )
    vae_model_src = root / "vae/minimax_h3_video_vae_fp16.safetensors"
    audio_vae_model_src = root / "vae/minimax_h3_audio_vae_fp32.safetensors"
    for file in (model_src, llm_model_src, vae_model_src, audio_vae_model_src):
        if not file.is_file():
            print(f"✖ missing model file: {file}", file=sys.stderr)
            return 1

    model_config: dict[str, Any] = {
        "mode": "video",
        "llmModelSrc": str(llm_model_src),
        "vaeModelSrc": str(vae_model_src),
        "audioVaeModelSrc": str(audio_vae_model_src),
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
                model_id = await load_model(
                    t,
                    model_src=str(model_src),
                    model_type="sdcpp-generation",
                    model_config=model_config,
                )

                request = VideoStreamRequest.model_validate(
                    {
                        "type": "videoStream",
                        "modelId": model_id,
                        "mode": "txt2vid",
                        "prompt": os.environ.get("PROMPT") or DEFAULT_PROMPT,
                        "negative_prompt": (
                            "extra people, duplicate cup, malformed hands, cup "
                            "fused to hand, text, subtitles, watermark, cartoon, "
                            "CGI, blur, flicker, jitter, camera shake"
                        ),
                        "width": 960,
                        "height": 544,
                        # H3 uses 17*k+5 frames; 124 frames at 24 FPS is
                        # approximately 5.17 seconds.
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
                        print(f"Step {response.step:.0f}/{response.total_steps:.0f}")
                    if response.data is not None:
                        clips.append(base64.b64decode(response.data))
                    if response.done:
                        stats = response.stats

                if not clips:
                    raise RuntimeError("Generation finished without an AVI result")
                output_path.write_bytes(clips[0])
                print(
                    f"Saved {output_path}",
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
