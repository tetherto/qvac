import {
  type GetSystemResourcesInput,
  type GetSystemResourcesRequest,
  type SystemResources
} from '@/schemas/index'
import { send } from '@/dispatch'
import { InvalidResponseError } from '@/errors/index'

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
