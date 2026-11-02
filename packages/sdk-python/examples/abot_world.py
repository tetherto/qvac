"""Python port of packages/sdk/examples/abot-world.ts.

ABot-World: build a world from a single image, then walk it. Each step
generates one block of video under the keys held for it and streams the
decoded frames.

Runs on the machine hosting the worker; there is no remote route. The default
832x480 tier needs >= 20 GB free VRAM on a dedicated GPU (24 GB card in
practice); pass 448 256 to use the low-VRAM tier, which runs on ~6 GB cards
well below interactive frame rates.

Three things differ from TypeScript:

  - The functions are `world_scene_stream` and `world_step_stream`, each one
    async iterator, where TypeScript's `worldCreateScene` and `worldStep`
    hand back several channels. The scene pack arrives as base64 `data`
    followed by `done` with `stats`; a block arrives as one `data` per frame,
    then a tick carrying `step` and `total_steps`, then `done` with `stats`.
  - `image` is the base64 of the first frame, not its bytes.
  - `request_id` is generated here. TypeScript's `worldStep` returns one to
    cancel against; on this path the field is optional and the worker invents
    one when it is missing, which leaves nothing to name in `cancel`.

RUN: python examples/abot_world.py <first-frame-image> [prompt] [output-dir] [blocks] [width] [height]
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import sys
import uuid
from pathlib import Path

from tetherto.qvac_sdk import (
    Client,
    InferenceCancelledError,
    WorldSceneStreamRequest,
    WorldStepStreamRequest,
    cancel,
    load_model,
    unload_model,
    world_scene_stream,
    world_step_stream,
)
from tetherto.qvac_sdk.models import (
    ABOT_WORLD_0_5B_LF_TAEHV_VAE,
    ABOT_WORLD_0_5B_LF_WAN_VAE,
    ABOT_WORLD_0_5B_Q8_0,
    UMT5_XXL_ENC_Q8_0,
)

# A scripted walk: forward, forward while looking right, forward, idle. `keys`
# also accepts a key-state object ({ W: true }) or a raw 8-bit mask, so a live
# keyboard handler can pass its state straight through.
TAPE: list[list[str]] = [["W"], ["W", "L"], ["W"], []]


async def main() -> int:
    first_frame_path = sys.argv[1] if len(sys.argv) > 1 else None
    prompt = (
        sys.argv[2]
        if len(sys.argv) > 2
        else "| unknown | A realistic outdoor world scene with a navigable path."
    )
    output_dir = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(".")
    blocks = int(sys.argv[4]) if len(sys.argv) > 4 else 8
    width = int(sys.argv[5]) if len(sys.argv) > 5 else 832
    height = int(sys.argv[6]) if len(sys.argv) > 6 else 480

    if not first_frame_path:
        print("✖ first frame image path is required", file=sys.stderr)
        print(
            "Usage: python examples/abot_world.py "
            "<firstFrameImage> [prompt] [outputDir] [blocks] [width] [height]",
            file=sys.stderr,
        )
        return 1

    async with Client() as client:
        t = client.transport
        try:
            print("▸ Loading ABot-World session (DiT + taehv + scene encoders)...")
            model_id = await load_model(
                t,
                model_src=ABOT_WORLD_0_5B_Q8_0,
                model_type="sdcpp-generation",
                model_config={
                    "mode": "world",
                    # Two different VAEs, and the names are close enough to
                    # swap by accident:
                    #   taehvModelSrc -- taew2_2, the tiny STREAMING decoder.
                    #     Turns each block's latents into pixels during the
                    #     walk. Used by every world_step_stream.
                    #   vaeModelSrc   -- the full-precision Wan2.2 VAE.
                    #     ENCODES the first frame during the scene stream, and
                    #     is not touched again after that.
                    # Swapping them loads at first and fails once the walk
                    # starts.
                    "taehvModelSrc": ABOT_WORLD_0_5B_LF_TAEHV_VAE,
                    "t5XxlModelSrc": UMT5_XXL_ENC_Q8_0,
                    "vaeModelSrc": ABOT_WORLD_0_5B_LF_WAN_VAE,
                    "world": {
                        "seed": 42,
                        # ~3.7x fewer frame-passes per block. Without it, block
                        # times ramp from ~1.8 s to ~7.5 s as the recompute
                        # window fills.
                        "kvCache": True,
                        # JPEG rather than PNG: a block is ~14 MB of raw
                        # pixels, and this example writes every frame to disk.
                        "frameJpegQuality": 85,
                    },
                },
            )

            print(
                "▸ Creating the world "
                "(umT5 prompt encode + Wan2.2 VAE first-frame encode)..."
            )
            creation = WorldSceneStreamRequest.model_validate(
                {
                    "type": "worldSceneStream",
                    "modelId": model_id,
                    "prompt": prompt,
                    "image": base64.b64encode(
                        Path(first_frame_path).read_bytes()
                    ).decode("ascii"),
                    "width": width,
                    "height": height,
                    # The world is live on the session without this; ask for
                    # the bytes only because this example saves them to walk
                    # the same world again later.
                    "returnPack": True,
                }
            )

            scene = b""
            scene_stats = None
            async for response in world_scene_stream(t, creation):
                if response.data is not None:
                    scene = base64.b64decode(response.data)
                if response.done:
                    scene_stats = response.stats

            scene_path = output_dir / "world.safetensors"
            scene_path.write_bytes(scene)
            scene_create_ms = (
                scene_stats.scene_create_ms
                if scene_stats and scene_stats.scene_create_ms is not None
                else "?"
            )
            print(
                f"  scene pack written to {scene_path} "
                f"({len(scene)} bytes, {scene_create_ms} ms)"
            )
            print(
                "  reuse it later with modelConfig.sceneSrc "
                "to walk this same world again"
            )

            print(f"▸ Walking {blocks} blocks...")
            frame_number = 0
            for block in range(blocks):
                keys = TAPE[block % len(TAPE)]
                # One block at a time: a second step while this one streams is
                # rejected, so drive the next call off this one rather than
                # firing them in parallel.
                step = WorldStepStreamRequest.model_validate(
                    {
                        "type": "worldStepStream",
                        "modelId": model_id,
                        "keys": keys,
                    }
                )

                stats = None
                async for response in world_step_stream(t, step):
                    if response.data is not None:
                        frame_path = output_dir / f"frame-{frame_number:04d}.jpg"
                        frame_path.write_bytes(base64.b64decode(response.data))
                        frame_number += 1
                    if response.done:
                        stats = response.stats

                frames = stats.frames if stats and stats.frames is not None else "?"
                step_ms = stats.step_ms if stats and stats.step_ms is not None else "?"
                print(
                    f"  block {block + 1}/{blocks} [{'+'.join(keys) or 'idle'}] — "
                    f"{frames} frames in {step_ms} ms"
                )

            print(f"✔ Wrote {frame_number} frames to {output_dir}")

            # Targeted cancellation. Cancel is block-granular: the engine has
            # no mid-block abort, so the current block finishes internally,
            # delivery stops, and the step raises rather than returning a
            # truncated block. A cancel that lands after the block already
            # finished legitimately succeeds instead -- both outcomes are
            # correct, so handle each.
            print("▸ Cancelling a block mid-flight to show the contract...")
            request_id = str(uuid.uuid4())
            cancelling = WorldStepStreamRequest.model_validate(
                {
                    "type": "worldStepStream",
                    "modelId": model_id,
                    "requestId": request_id,
                    "keys": ["W"],
                }
            )

            async def cancel_soon() -> None:
                await asyncio.sleep(0.2)
                # The block can finish before this lands, and cancelling a
                # request that is no longer in flight fails. The walk below
                # reports whichever outcome won.
                with contextlib.suppress(Exception):
                    await cancel(t, request_id=request_id)

            canceller = asyncio.create_task(cancel_soon())
            try:
                async for _ in world_step_stream(t, cancelling):
                    pass
                print(
                    "  the block completed before the cancel landed "
                    "(the tolerated race)"
                )
            except InferenceCancelledError as error:
                print(f"  cancelled as expected: {error}")
            finally:
                canceller.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await canceller

            # A cancelled step is terminal for the native session, but the SDK
            # drops it for you: another world_step_stream on this same model_id
            # would transparently rebuild from the promoted pack, with no
            # unload/load cycle. Unloading here only because the example is
            # finished.
            await unload_model(t, model_id)
        except Exception as error:
            print(f"✖ World walk failed: {error}", file=sys.stderr)
            return 1

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
