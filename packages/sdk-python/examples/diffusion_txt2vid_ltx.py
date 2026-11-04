"""Python port of packages/sdk/examples/diffusion-txt2vid-ltx.ts.

Text-to-video (+ synchronized audio) with LTX-2. Unlike Wan, LTX-2 uses a
Gemma text encoder (llmModelSrc), a video VAE (vaeModelSrc), a set of
text-embedding connectors (embeddingsConnectorsModelSrc -- this is what selects
the LTX-2 layout), and an optional audio VAE (audioVaeModelSrc) that produces a
48 kHz audio track muxed into the output AVI.

This example needs powerful hardware: LTX-2.3 is a ~21B model, budget at least
20+ GB of video / unified memory.

Pass your own paths / URLs via argv to override any of the five sources.

TypeScript's `video()` hands back three channels -- `progressStream`, `outputs`
and `stats`. Python exposes one async iterator instead, and each `video_stream`
response carries whichever of those three it is: `step` with `total_steps`
while denoising, base64 `data` for a finished clip, and `done` with `stats` at
the end.

RUN: python examples/diffusion_txt2vid_ltx.py [diffusion-src] [llm-src] [vae-src] [audio-vae-src] [connectors-src] [prompt] [output-dir]
"""

from __future__ import annotations

import asyncio
import base64
import sys
from pathlib import Path

from tetherto.qvac_sdk import (
    Client,
    VideoStreamRequest,
    load_model,
    unload_model,
    video_stream,
)
from tetherto.qvac_sdk.models import (
    GEMMA_3_12B_Q4_K_XL,
    LTX_2_3_22B_DISTILLED_EMBEDDINGS_CONNECTORS,
    LTX_2_3_22B_Q5_K_M,
    LTX_2_3_AUDIO_VAE,
    LTX_2_3_VIDEO_VAE,
)


def print_progress(p) -> None:
    """Print model download progress; pass as `on_progress=` to `load_model`."""
    line = (
        f"▸ Downloading {p.percentage:.0f}% "
        f"({p.downloaded / 1e6:.1f}/{p.total / 1e6:.1f} MB)"
    )
    print(line, end="\r" if sys.stderr.isatty() else "\n", file=sys.stderr)
    if p.percentage >= 100:
        print(file=sys.stderr)


async def main() -> int:
    diffusion_model_src = sys.argv[1] if len(sys.argv) > 1 else LTX_2_3_22B_Q5_K_M
    llm_model_src = sys.argv[2] if len(sys.argv) > 2 else GEMMA_3_12B_Q4_K_XL
    vae_model_src = sys.argv[3] if len(sys.argv) > 3 else LTX_2_3_VIDEO_VAE
    audio_vae_model_src = sys.argv[4] if len(sys.argv) > 4 else LTX_2_3_AUDIO_VAE
    embeddings_connectors_model_src = (
        sys.argv[5]
        if len(sys.argv) > 5
        else LTX_2_3_22B_DISTILLED_EMBEDDINGS_CONNECTORS
    )

    prompt = (
        sys.argv[6] if len(sys.argv) > 6 else "a claymation cat playing jazz on a piano"
    )
    output_dir = Path(sys.argv[7]) if len(sys.argv) > 7 else Path(".")

    print(
        "▸ Loading LTX-2 model "
        "(diffusion + Gemma + video VAE + audio VAE + connectors)..."
    )

    try:
        async with Client() as client:
            t = client.transport

            model_id = await load_model(
                t,
                model_src=diffusion_model_src,
                model_type="sdcpp-generation",
                model_config={
                    "mode": "video",
                    "device": "gpu",
                    "threads": 4,
                    # Supplying embeddingsConnectorsModelSrc selects the LTX-2
                    # layout.
                    "llmModelSrc": llm_model_src,
                    "vaeModelSrc": vae_model_src,
                    "audioVaeModelSrc": audio_vae_model_src,
                    "embeddingsConnectorsModelSrc": embeddings_connectors_model_src,
                    "diffusion_fa": True,
                    "vae_tiling": True,
                },
                on_progress=print_progress,
            )
            print(f"▸ Model loaded: {model_id}")

            print(f'\n▸ Generating video for: "{prompt}"')

            request = VideoStreamRequest.model_validate(
                {
                    "type": "videoStream",
                    "modelId": model_id,
                    "mode": "txt2vid",
                    "prompt": prompt,
                    "negative_prompt": (
                        "blurry, low quality, static, jittery, watermark, "
                        "distorted audio"
                    ),
                    # LTX-2 requires width/height as multiples of 32.
                    "width": 512,
                    "height": 320,
                    # LTX-2 requires (8*k + 1) frames, max 257. At 24 fps:
                    # 25~=1s, 121~=5s, 241~=10s.
                    "video_frames": 121,
                    "fps": 24,
                    # Distilled variants run in 4-8 steps with cfg ~1.0; the
                    # full --dev model wants steps >= 20 and cfg ~7.0.
                    "steps": 10,
                    "cfg_scale": 1.0,
                    "seed": 42,
                    # Tile the video VAE decode along the time axis to cap peak
                    # VRAM on long / HD clips (LTX-2 only).
                    "temporal_tiling": True,
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

            for index, clip in enumerate(clips):
                output_path = output_dir / f"ltx_t2v_{index}.avi"
                output_path.write_bytes(clip)
                print(
                    f"▸ Saved {output_path} "
                    "(play in VLC to hear the muxed audio track)"
                )

            print("\n▸ Stats:", stats.model_dump(exclude_none=True) if stats else None)

            await unload_model(t, model_id)
            print("▸ Done")
    except Exception as error:
        print("✖", error, file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
