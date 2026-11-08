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
 * @throws {RequestValidationFailedError} Client-side, before any RPC, if the
 *   prompt is empty, the dimensions are not positive multiples of 32 within the
 *   per-axis and total-pixel ceilings, or the first frame exceeds 3 MB.
 *   Server-side, before the session is touched, if the first frame's header
 *   declares more than 8192x8192 pixels or cannot be read. Raised as
 *   `PluginRequestValidationFailedError` on the engine; that class is not
 *   exported from the client package and is not in the RPC reconstructor map, so
 *   match it on message rather than with `instanceof`.
 *
 * @throws {ModelOperationNotSupportedError} If the model was not loaded with
 *   `mode: "world"`.
 *
 * @throws {RequestRejectedByPolicyError} If a world job is already running on
 *   this model — world refuses rather than queues.
 *
 * @throws {InferenceCancelledError} If cancel by request id is accepted.
 *   Scene creation is uninterruptible, so this stops delivery while the encode
 *   runs to completion.
 *
 * @throws {StreamEndedError} If the RPC stream closes without a terminal
 *   `done` chunk.
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
 * @throws {RequestValidationFailedError} Client-side, before any RPC, on an
 *   unknown walk key.
 *
 * @throws {ModelOperationNotSupportedError} If the model was not loaded with
 *   `mode: "world"`.
 *
 * @throws {RequestRejectedByPolicyError} If a block is already in flight on
 *   this model.
 *
 * @throws {InferenceCancelledError} If cancel by request id is accepted. The
 *   step rejects rather than resolving with a truncated block, and the session
 *   is rebuilt on the next call.
 *
 * @throws {StreamEndedError} If the RPC stream closes without a terminal
 *   `done` chunk.
 */
export function worldStep(params: WorldStepClientParams): WorldStepResult {
  return createWorldStepResult(params, streamRpc)
}
