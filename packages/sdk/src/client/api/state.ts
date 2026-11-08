import { send } from '@/client/rpc/rpc-client'
import type { LifecycleState } from '@qvac/inference/surface'
import { InvalidResponseError } from '@/utils/errors-client'

/**
 * Returns the current runtime lifecycle state.
 *
 * @throws {InvalidResponseError} When the response envelope does not match the request type.
 */
export async function state(): Promise<LifecycleState> {
  const response = await send({ type: 'state' })
  if (response.type !== 'state') {
    throw new InvalidResponseError('state')
  }
  return response.state
}
