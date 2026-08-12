import type { WorldSceneClientParams, WorldStepClientParams } from '@/schemas/sdcpp-config'
import { stream as streamRpc } from '@/client/rpc/rpc-client'
import {
  createWorldSceneResult,
  createWorldStepResult,
  type WorldSceneResult,
  type WorldStepResult
} from '@/client/api/world-result'

/**
 * Builds a world for an ABot-World session: the prompt and first frame are
 * encoded into a scene pack the walk then runs on.
 *
 * Run this once per world. The returned pack can be stored and passed back as
 * `modelConfig.sceneSrc` on a later `loadModel` to revisit the same world.
 * Creating a world on a session that is already walking replaces it and
 * restarts the walk from the beginning.
 *
 * Scene creation cannot be interrupted — the engine exposes no abort hook for
 * it — so `cancel(requestId)` stops the SDK from yielding but the encode runs
 * to completion. Await the result before unloading the model.
 *
 * @param params - Loaded world model ID, scene prompt, first-frame image bytes, and optional dimensions.
 * @returns `requestId`, `scene` (promise of the scene pack), and `stats`.
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
 * const { scene } = worldCreateScene({
 *   modelId,
 *   prompt: "| unknown | A realistic outdoor world scene with a navigable path.",
 *   image: fs.readFileSync("first-frame.jpg"),
 * });
 * fs.writeFileSync("world.safetensors", await scene);
 * ```
 */
export function worldCreateScene(params: WorldSceneClientParams): WorldSceneResult {
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
