import { send } from '@/client/rpc/rpc-client'
import { InvalidResponseError } from '@/utils/errors-client'

/**
 * Suspends the SDK runtime: pauses all registered Hyperswarm and Corestore
 * resources and engages the lifecycle gate so non-lifecycle operations are
 * blocked until `resume()` is called.
 *
 * @throws {RPCError} When one or more resources fail to suspend. The runtime
 *   still commits to `"suspended"` so callers can recover with `resume()`.
 */
export async function suspend(): Promise<void> {
  const response = await send({ type: 'suspend' })
  if (response.type !== 'suspend') {
    throw new InvalidResponseError('suspend')
  }
}
