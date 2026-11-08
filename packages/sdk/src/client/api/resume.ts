import { send } from '@/client/rpc/rpc-client'
import { InvalidResponseError } from '@/utils/errors-client'

/**
 * Resumes the SDK runtime: restores all suspended Hyperswarm and Corestore
 * resources and releases the lifecycle gate so all SDK operations are allowed
 * again.
 *
 * @throws {RPCError} When one or more resources fail to resume. On partial
 *   failure the runtime stays `"suspended"` (operations remain blocked) so
 *   callers can retry `resume()`.
 */
export async function resume(): Promise<void> {
  const response = await send({ type: 'resume' })
  if (response.type !== 'resume') {
    throw new InvalidResponseError('resume')
  }
}
