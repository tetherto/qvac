import type {
  GetRuntimeCapabilitiesRequest,
  RuntimeCapability,
  RPCOptions
} from '@qvac/inference/surface'
import { send } from '@/client/rpc/rpc-client'
import { InvalidResponseError } from '@/utils/errors-client'

/**
 * List the capability contracts the runtime's registered plugins declare,
 * with the major version of each. A consumer checks for the `id` and
 * `version` it was built against before loading a model.
 *
 * The report reads plugin registration only. It loads no model, and it does
 * not check addons, model files, resources or permissions, so a listed
 * operation can still fail for a given model. An operation in
 * `partialOperations` is implemented by only some of the contract's plugins,
 * and a call uses the plugin of the model it names.
 *
 * @param options - Optional RPC options.
 * @returns One entry per contract ID and major, sorted by ID and then version.
 * Empty when no registered plugin declares a contract.
 * @throws {InvalidResponseError} If the worker returns a different response type.
 * @throws {Error} If the RPC request fails, including on a worker released
 * before this request existed.
 *
 * @example
 * ```typescript
 * const capabilities = await getRuntimeCapabilities()
 * const canTranscribe = capabilities.some((c) => c.id === 'transcription' && c.version === 1)
 * ```
 */
export async function getRuntimeCapabilities(options?: RPCOptions): Promise<RuntimeCapability[]> {
  const request: GetRuntimeCapabilitiesRequest = { type: 'getRuntimeCapabilities' }
  const response = await send(request, options)
  if (response.type !== 'getRuntimeCapabilities') {
    throw new InvalidResponseError('getRuntimeCapabilities')
  }
  return response.capabilities
}
