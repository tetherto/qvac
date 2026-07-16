import { type HeartbeatRequest, type HeartbeatResponse } from '../schemas/index.ts'
import type { DelegateBase } from '../schemas/delegate.ts'
import { send } from '../dispatch.ts'
import { InvalidResponseError } from '../errors/index.ts'

/**
 * Checks if a delegated provider is online by sending a heartbeat round-trip.
 * Can also be used to check if the local engine is responsive.
 *
 * @param params - Delegation target to check
 * @param params.delegate - The provider to check (providerPublicKey + optional timeout)
 * @returns A promise that resolves to a heartbeat response if the provider is reachable.
 * @throws {QvacErrorBase} When the provider is unreachable or the response is invalid.
 *
 * @example
 * // Check if a delegated provider is online
 * try {
 *   await heartbeat({
 *     delegate: { providerPublicKey: "peerHex", timeout: 3000 },
 *   });
 *   console.log("Provider is online");
 * } catch {
 *   console.log("Provider is offline");
 * }
 *
 * @example
 * // Check if the local engine is responsive
 * await heartbeat();
 */
export async function heartbeat(params?: { delegate?: DelegateBase }): Promise<HeartbeatResponse> {
  const request: HeartbeatRequest = {
    type: 'heartbeat',
    ...(params?.delegate && { delegate: params.delegate })
  }

  const response = await send(request)
  if (response.type !== 'heartbeat') {
    throw new InvalidResponseError('heartbeat')
  }

  return response
}
