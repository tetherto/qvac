import {
  type HeartbeatRequest,
  type HeartbeatResponse,
  type RPCOptions
} from '@qvac/inference/surface'
import { send } from '@/client/rpc/rpc-client'
import { InvalidResponseError } from '@/utils/errors-client'

/**
 * Checks whether the local SDK worker is responsive by sending a heartbeat
 * round-trip.
 *
 * @param options - Optional RPC options (timeout, profiling, force new connection).
 * @returns A promise that resolves to a heartbeat response.
 * @throws {QvacErrorBase} When the response is invalid.
 *
 * @example
 * await heartbeat();
 */
export async function heartbeat(options?: RPCOptions): Promise<HeartbeatResponse> {
  const request: HeartbeatRequest = { type: 'heartbeat' }

  const response = await send(request, options)
  if (response.type !== 'heartbeat') {
    throw new InvalidResponseError('heartbeat')
  }

  return response
}
