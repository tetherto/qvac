import type { WorldSceneClientParams, WorldStepClientParams } from '@/schemas/sdcpp-config'
import { stream as streamRpc } from '@/client/rpc/rpc-client'
import {
  createWorldSceneResult,
  createWorldStepResult,
  type WorldSceneResult,
  type WorldSceneResultWithPack,
  type WorldStepResult
} from '@/client/api/world-result'

/**
 * Builds a world for an ABot-World session: the prompt and first frame are
 * encoded into a scene pack the walk then runs on.
 *
 * Run this once per world. The world is live on the session as soon as this
 * completes — `stats` is the completion signal. Creating a world on a session
 * that is already walking replaces it and restarts the walk from the beginning.
 *
 * The pack itself is NOT returned by default: it is 10+ MB, a third larger again
 * as base64, and the common create-then-walk-now flow never touches the bytes.
 * Pass `returnPack: true` to get them, save them, and pass that file back as
 * `modelConfig.sceneSrc` on a later `loadModel` to walk the same world again.
 * `sceneSrc` takes a path or URL, so persist the bytes yourself.
 *
 * Scene creation cannot be interrupted — the engine exposes no abort hook for
 * it — so `cancel({ requestId })` stops the SDK from yielding but the encode runs
 * to completion. Await the result before unloading the model.
 *
 * @param params - Loaded world model ID, scene prompt, first-frame image bytes, optional dimensions, and `returnPack`.
 * @returns `requestId` and `stats`; plus `scene` (promise of the pack) when `returnPack: true`.
 *
 * @example
 * ```typescript
 * const modelId = await loadModel({
 *   modelType: "diffusion",
 *   modelSrc: ABOT_WORLD_0_5B_Q8_0,
 *   modelConfig: {
 *     mode: "world",
 *     taehvModelSrc: ABOT_WORLD_0_5B_LF_VAE,
 *     t5XxlModelSrc: UMT5_XXL_ENC_Q8_0,
 *     vaeModelSrc: ABOT_WORLD_0_5B_LF_VAE_F16,
 *     world: { seed: 42, kvCache: true },
 *   },
 * });
 *
 * // Walk it now and never persist it: no pack crosses the wire.
 * const { stats } = worldCreateScene({
 *   modelId,
 *   prompt: "| unknown | A realistic outdoor world scene with a navigable path.",
 *   image: fs.readFileSync("first-frame.jpg"),
 * });
 * await stats;
 *
 * // Or keep it, to walk the same world after a reload.
 * const { scene } = worldCreateScene({
 *   modelId,
 *   prompt: "| unknown | A realistic outdoor world scene with a navigable path.",
 *   image: fs.readFileSync("first-frame.jpg"),
 *   returnPack: true,
 * });
 * fs.writeFileSync("world.safetensors", await scene);
 * ```
 */
export function worldCreateScene(
  params: WorldSceneClientParams & { returnPack: true }
): WorldSceneResultWithPack
export function worldCreateScene(params: WorldSceneClientParams): WorldSceneResult
export function worldCreateScene(
  params: WorldSceneClientParams
): WorldSceneResult | WorldSceneResultWithPack {
  return createWorldSceneResult(params, streamRpc)
}

/**
 * Generates the next block of an ABot-World walk under the keys held for it.
 *
 * One call produces one block: 9 frames for the first block after the session
 * loads (decoder warmup), 12 thereafter. Frames arrive on `frameStream` as they
 * are decoded, so a viewer can display them without waiting for the block.
 *
 * Only one block runs at a time per model — a second call while one is in
 * flight is rejected rather than queued, so drive the next call off the
 * previous one. Cancelling has block granularity: the current block finishes
 * internally, delivery stops, and the call rejects rather than returning a
 * truncated block.
 *
 * `keys` accepts an array, a key-state object, or a raw 8-bit mask. WASD move,
 * IJKL steer the camera; omit for an idle block.
 *
 * @param params - Loaded world model ID and the keys held for this block.
 * @returns `requestId`, `frameStream`, `frames` (the whole block), and `stats`.
 *
 * @example Walk forward, displaying frames as they arrive
 * ```typescript
 * const { frameStream } = worldStep({ modelId, keys: ["W"] });
 * for await (const frame of frameStream) {
 *   display(frame); // PNG, or JPEG when world.frameJpegQuality is set
 * }
 * ```
 *
 * @example Drive a key loop off the one-block-at-a-time contract
 * ```typescript
 * while (walking) {
 *   const { frames } = worldStep({ modelId, keys: heldKeys }); // e.g. { W: true, L: true }
 *   for (const frame of await frames) display(frame);
 * }
 * ```
 */
export function worldStep(params: WorldStepClientParams): WorldStepResult {
  return createWorldStepResult(params, streamRpc)
}
