import { type HeartbeatRequest, type HeartbeatResponse } from '@qvac/inference/surface'
import { send } from '@/client/rpc/rpc-client'
import { InvalidResponseError } from '@/utils/errors-client'

/**
 * Checks whether the local SDK worker is responsive by sending a heartbeat
 * round-trip.
 *
 * @throws {QvacErrorBase} When the response is invalid.
 */
export async function heartbeat(): Promise<HeartbeatResponse> {
  const request: HeartbeatRequest = { type: 'heartbeat' }

  const response = await send(request)
  if (response.type !== 'heartbeat') {
    throw new InvalidResponseError('heartbeat')
  }

  return response
}
