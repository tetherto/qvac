"""Python port of packages/sdk/examples/diffusion-img2vid-ltx.ts.

Image-to-video (+ synchronized audio) with LTX-2. Unlike Wan I2V, LTX-2
conditions on the first frame through its video VAE, so it needs NO CLIP vision
weights (clipVisionModelSrc) -- the same LTX-2 layout used for txt2vid works
for img2vid, you just add an init_image at generation time.

This example needs powerful hardware: LTX-2.3 is a ~21B model, budget at least
20+ GB of video / unified memory.

Pass your own paths / URLs via argv to override any of the five sources.

TypeScript's `video()` takes `init_image` as raw bytes and base64-encodes them
on the way to the worker. Python calls the worker directly through
`video_stream`, where `init_image` is already the encoded string, so the
example encodes the file itself. The same iterator then carries progress, the
finished clips and the closing stats, which TypeScript receives as three
separate channels.

RUN: python examples/diffusion_img2vid_ltx.py <init-image> [prompt] [output-dir] [diffusion-src] [llm-src] [vae-src] [audio-vae-src] [connectors-src]
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
    init_image_path = sys.argv[1] if len(sys.argv) > 1 else None
    prompt = (
        sys.argv[2]
        if len(sys.argv) > 2
        else "the subject slowly turns and smiles, soft natural lighting, cinematic"
    )
    output_dir = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(".")
    diffusion_model_src = sys.argv[4] if len(sys.argv) > 4 else LTX_2_3_22B_Q5_K_M
    llm_model_src = sys.argv[5] if len(sys.argv) > 5 else GEMMA_3_12B_Q4_K_XL
    vae_model_src = sys.argv[6] if len(sys.argv) > 6 else LTX_2_3_VIDEO_VAE
    audio_vae_model_src = sys.argv[7] if len(sys.argv) > 7 else LTX_2_3_AUDIO_VAE
    embeddings_connectors_model_src = (
        sys.argv[8]
        if len(sys.argv) > 8
        else LTX_2_3_22B_DISTILLED_EMBEDDINGS_CONNECTORS
    )

    if not init_image_path:
        print("✖ init image path is required", file=sys.stderr)
        print(
            "Usage: python examples/diffusion_img2vid_ltx.py <initImagePath> "
            "[prompt] [outputDir] [diffusionModelSrc] [llmModelSrc] "
            "[vaeModelSrc] [audioVaeModelSrc] [embeddingsConnectorsModelSrc]",
            file=sys.stderr,
        )
        return 1

    print(
        "▸ Loading LTX-2 model "
        "(diffusion + Gemma + video VAE + audio VAE + connectors)..."
    )

    try:
        async with Client() as client:
            t = client.transport

            # no clipVisionModelSrc -- LTX-2 img2vid does not use CLIP vision.
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

            init_image = base64.b64encode(Path(init_image_path).read_bytes()).decode(
                "ascii"
            )
            print(f'▸ Generating video for: "{prompt}"')

            request = VideoStreamRequest.model_validate(
                {
                    "type": "videoStream",
                    "modelId": model_id,
                    "mode": "img2vid",
                    "prompt": prompt,
                    "init_image": init_image,
                    "negative_prompt": (
                        "blurry, distorted, low quality, jittery, static, frozen, "
                        "distorted audio"
                    ),
                    "strength": 0.85,
                    # LTX-2 requires width/height as multiples of 32 and
                    # (8*k + 1) frames (max 257).
                    "width": 512,
                    "height": 320,
                    "video_frames": 121,
                    "fps": 24,
                    "steps": 10,
                    "cfg_scale": 1.0,
                    "seed": 42,
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
                output_path = output_dir / f"ltx_i2v_{index}.avi"
                output_path.write_bytes(clip)
                print(
                    f"▸ Saved {output_path} "
                    "(play in VLC to hear the muxed audio track)"
                )

            print("▸ Stats:", stats.model_dump(exclude_none=True) if stats else None)

            await unload_model(t, model_id)
            print("▸ Done")
    except Exception as error:
        print("✖", error, file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
