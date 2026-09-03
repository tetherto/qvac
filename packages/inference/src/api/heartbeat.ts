import { type HeartbeatRequest, type HeartbeatResponse } from '@/schemas/index'
import { send } from '@/dispatch'
import { InvalidResponseError } from '@/errors/index'

/**
 * Checks whether the local engine is responsive by sending a heartbeat
 * round-trip.
 *
 * @returns A promise that resolves to a heartbeat response.
 * @throws {QvacErrorBase} When the response is invalid.
 *
 * @example
 * await heartbeat();
 */
export async function heartbeat(): Promise<HeartbeatResponse> {
  const request: HeartbeatRequest = { type: 'heartbeat' }

  const response = await send(request)
  if (response.type !== 'heartbeat') {
    throw new InvalidResponseError('heartbeat')
  }

  return response
}
