import type { WorldSceneClientParams, WorldStepClientParams } from '@qvac/inference/surface'
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
 * that already has one replaces it and restarts the walk from the beginning.
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
 * @throws {RequestValidationFailedError} Client-side, before any RPC, if the
 *   prompt is empty, the dimensions are not positive multiples of 32 within the
 *   per-axis and total-pixel ceilings, or the first frame exceeds 3 MB.
 * @throws Server-side, before the session is touched, if the first frame's
 *   header declares more than 8192x8192 pixels or cannot be read. Raised as
 *   `PluginRequestValidationFailedError` on the engine; that class is not
 *   exported from the client package and is not in the RPC reconstructor map, so
 *   match it on message rather than with `instanceof`.
 * @throws {ModelOperationNotSupportedError} If the model was not loaded with
 *   `mode: "world"`.
 * @throws {RequestRejectedByPolicyError} If a world job is already running on
 *   this model — world refuses rather than queues.
 * @throws {InferenceCancelledError} If `cancel({ requestId })` is accepted.
 *   Scene creation is uninterruptible, so this stops delivery while the encode
 *   runs to completion.
 * @throws {StreamEndedError} If the RPC stream closes without a terminal
 *   `done` chunk.
 *
 * @example
 * ```typescript
 * const modelId = await loadModel({
 *   modelType: "diffusion",
 *   modelSrc: ABOT_WORLD_0_5B_Q8_0,
 *   modelConfig: {
 *     mode: "world",
 *     taehvModelSrc: ABOT_WORLD_0_5B_LF_TAEHV_VAE,
 *     t5XxlModelSrc: UMT5_XXL_ENC_Q8_0,
 *     vaeModelSrc: ABOT_WORLD_0_5B_LF_WAN_VAE,
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
export function worldCreateScene(
  params: WorldSceneClientParams & { returnPack?: false | undefined }
): WorldSceneResult
export function worldCreateScene(
  params: WorldSceneClientParams
): WorldSceneResult | WorldSceneResultWithPack
export function worldCreateScene(
  params: WorldSceneClientParams
): WorldSceneResult | WorldSceneResultWithPack {
  return createWorldSceneResult(params, streamRpc)
}

/**
 * Generates the next block of an ABot-World walk under the keys held for it.
 *
 * One call produces one block: at the default `world.numFramePerBlock`, 9 frames
 * for the first block after the session loads (decoder warmup) and 12
 * thereafter. Both counts move with `numFramePerBlock`, so read `stats.frames`
 * rather than assuming them. Frames arrive on `frameStream` as they are decoded,
 * so a viewer can display them without waiting for the block.
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
 * `progressStream` forwards the engine's `{ step, totalSteps, elapsedMs }` tick,
 * the same shape `video` and `diffusion` emit. The engine fires it once per
 * block, AFTER the frames, so it is an end-of-block summary rather than
 * mid-block liveness — one tick per `worldStep` call.
 *
 * @param params - Loaded world model ID and the keys held for this block.
 * @returns `requestId`, `frameStream`, `progressStream`, `frames` (the whole block), and `stats`.
 * @throws {RequestValidationFailedError} Client-side, before any RPC, on an
 *   unknown walk key.
 * @throws {ModelOperationNotSupportedError} If the model was not loaded with
 *   `mode: "world"`.
 * @throws {RequestRejectedByPolicyError} If a block is already in flight on
 *   this model.
 * @throws {InferenceCancelledError} If `cancel({ requestId })` is accepted. The
 *   step rejects rather than resolving with a truncated block, and the session
 *   is rebuilt on the next call.
 * @throws {StreamEndedError} If the RPC stream closes without a terminal
 *   `done` chunk.
 *
 * @example Walk forward, displaying frames as they arrive
 * ```typescript
 * const { frameStream } = worldStep({ modelId, keys: ["W"] });
 * for await (const frame of frameStream) {
 *   display(frame); // PNG, or JPEG when world.frameJpegQuality is set
 * }
 * ```
 *
 * @example Report what each block did
 * ```typescript
 * const { progressStream, frames } = worldStep({ modelId, keys: ["W"] });
 * for await (const { totalSteps, elapsedMs } of progressStream) {
 *   // Once per block, after its frames: a summary, not a spinner tick.
 *   report(`block delivered ${totalSteps} frames in ${elapsedMs}ms`);
 * }
 * for (const frame of await frames) display(frame);
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
