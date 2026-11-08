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
 * @throws {InvalidResponseError} When the worker returns an unexpected response.
 *
 * @throws {ModelNotFoundError} When no loaded model has the requested ID.
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
