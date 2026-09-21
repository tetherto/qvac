import {
  type GetSystemResourcesInput,
  type GetSystemResourcesRequest,
  type SystemResources
} from '@qvac/inference/surface'
import { send } from '@/client/rpc/rpc-client'
import { InvalidResponseError } from '@/utils/errors-client'

/**
 * Read the worker's system capabilities and optional resource sample.
 *
 * @param input - Optional settings; set `sample` to request a current resource sample.
 * @returns System capabilities with availability information and a sample when provided by the worker.
 * @throws {InvalidResponseError} If the worker returns a different response type.
 * @throws {Error} If the RPC request fails.
 */
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
