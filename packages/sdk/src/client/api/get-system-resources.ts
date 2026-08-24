import {
  type GetSystemResourcesInput,
  type GetSystemResourcesRequest,
  type SystemResources
} from '@qvac/inference/surface'
import { send } from '@/client/rpc/rpc-client'
import { InvalidResponseError } from '@/utils/errors-client'

export async function getSystemResources(
  input?: GetSystemResourcesInput
): Promise<SystemResources> {
  const request: GetSystemResourcesRequest = {
    type: 'getSystemResources',
    ...(input?.sample !== undefined && { sample: input.sample })
  }

  const response = await send(request)
  if (response.type !== 'getSystemResources') {
    throw new InvalidResponseError('getSystemResources')
  }

  return {
    capabilities: response.capabilities,
    ...(response.sample && { sample: response.sample })
  }
}
