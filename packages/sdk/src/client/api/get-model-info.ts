import {
  type GetModelInfoRequest,
  type GetModelInfoParams,
  type ModelInfo
} from '@qvac/inference/surface'
import { send } from '@/client/rpc/rpc-client'
import { InvalidResponseError } from '@/utils/errors-client'

/**
 * Returns status information for a catalog model, including cache state and loaded instances.
 *
 * @throws {QvacErrorBase} When the response type is invalid (`InvalidResponseError`) or the RPC layer fails.
 */
export async function getModelInfo(params: GetModelInfoParams): Promise<ModelInfo> {
  const request: GetModelInfoRequest = {
    type: 'getModelInfo',
    name: params.name
  }

  const response = await send(request)
  if (response.type !== 'getModelInfo') {
    throw new InvalidResponseError('getModelInfo')
  }

  return response.modelInfo
}
