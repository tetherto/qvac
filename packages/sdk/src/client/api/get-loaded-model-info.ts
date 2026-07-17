import {
  type GetLoadedModelInfoParams,
  type GetLoadedModelInfoRequest,
  type LoadedModelInfo
} from '@qvac/inference/surface'
import { type RPCOptions } from '@qvac/inference/surface'
import { send } from '@/client/rpc/rpc-client'
import { InvalidResponseError } from '@/utils/errors-client'

/**
 * Returns introspection info for a loaded `modelId` (local or delegated).
 *
 * For local models, `info.modelType` and `info.handlers` are authoritative.
 * Use them to preflight an SDK call before sending the actual RPC, e.g.
 * confirm that a model supports `transcribeStream` before calling `transcribe()`.
 *
 * For delegated models, only `modelId`, `isDelegated: true`, `providerInfo`,
 * and `handlers: []` are populated. Preflight against a delegated model is
 * best-effort and falls through to the provider's error response.
 *
 * Throws `ModelNotFoundError` if no entry exists for `modelId`.
 *
 * @param params - The identifier of the loaded model to inspect.
 * @param rpcOptions - Optional timeout, profiling, and connection settings.
 * @returns The model's local handler metadata or delegated-provider summary.
 * @throws {InvalidResponseError} When the worker returns an unexpected response.
 * @throws {ModelNotFoundError} When no loaded model has the requested ID.
 *
 * @example
 * ```typescript
 * const info = await getLoadedModelInfo({ modelId });
 * if (info.isDelegated || info.handlers.includes("completionStream")) {
 *   // safe to call completion(); delegated path defers to provider
 * }
 * ```
 */
export async function getLoadedModelInfo(
  params: GetLoadedModelInfoParams,
  rpcOptions?: RPCOptions
): Promise<LoadedModelInfo> {
  const request: GetLoadedModelInfoRequest = {
    type: 'getLoadedModelInfo',
    modelId: params.modelId
  }

  const response = await send(request, rpcOptions)
  if (response.type !== 'getLoadedModelInfo') {
    throw new InvalidResponseError('getLoadedModelInfo')
  }

  return response.info
}
