import type { GetRuntimeCapabilitiesRequest, RuntimeCapability } from '@/schemas/index'
import { send } from '@/dispatch'
import { InvalidResponseError } from '@/errors/index'

/**
 * Lists the capability contracts the registered plugins provide, with the
 * major version of each. Reads plugin registration only, so it loads no
 * model and works before any plugin is registered.
 *
 * @returns One entry per contract ID and major, sorted by ID and then version.
 * @throws {InvalidResponseError} If the engine returns a different response type.
 */
export async function getRuntimeCapabilities(): Promise<RuntimeCapability[]> {
  const request: GetRuntimeCapabilitiesRequest = { type: 'getRuntimeCapabilities' }
  const response = await send(request)
  if (response.type !== 'getRuntimeCapabilities') {
    throw new InvalidResponseError('getRuntimeCapabilities')
  }
  return response.capabilities
}
