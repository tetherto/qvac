import {
  type GetLoadedModelInfoParams,
  type GetLoadedModelInfoRequest,
  type LoadedModelInfo
} from '@/schemas/index'
import { type RPCOptions } from '@/schemas/common'
import { send } from '@/dispatch'
import { InvalidResponseError } from '@/errors/index'

/**
 * Returns introspection info for a loaded `modelId`.
 *
 * `info.modelType` and `info.handlers` are authoritative. Use them to preflight
 * a call before making the actual request, e.g. confirm that a model supports
 * `transcribeStream` before calling `transcribe()`.
 *
 * Throws `ModelNotFoundError` if no entry exists for `modelId`.
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
