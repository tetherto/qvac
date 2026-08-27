import {
  type GetLoadedModelInfoParams,
  type GetLoadedModelInfoRequest,
  type LoadedModelInfo,
  type RPCOptions
} from '@qvac/inference/surface'
import { send } from '@/client/rpc/rpc-client'
import { InvalidResponseError } from '@/utils/errors-client'

/**
 * Returns introspection info for a loaded `modelId`.
 *
 * `info.modelType` and `info.handlers` are authoritative. Use them to preflight
 * an SDK call before sending the actual RPC, e.g. confirm that a model supports
 * `transcribeStream` before calling `transcribe()`.
 *
 * Throws `ModelNotFoundError` if no entry exists for `modelId`.
 *
 * @param params - The identifier of the loaded model to inspect.
 * @param rpcOptions - Optional timeout, profiling, and connection settings.
 * @returns The model's handler metadata.
 * @throws {InvalidResponseError} When the worker returns an unexpected response.
 * @throws {ModelNotFoundError} When no loaded model has the requested ID.
 *
 * @example
 * ```typescript
 * const info = await getLoadedModelInfo({ modelId });
 * if (info.handlers.includes("completionStream")) {
 *   // safe to call completion()
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
