import { send } from '../dispatch'
import type { LifecycleState } from '../schemas'
import { InvalidResponseError } from '../errors'

/**
 * Returns the current runtime lifecycle state.
 *
 * Safe to call from any lifecycle state — `state()` is never blocked by the
 * lifecycle gate (along with `suspend()` and `resume()`).
 *
 * @returns The current lifecycle state:
 *   - `"active"`: all operations are allowed
 *   - `"suspending"` | `"suspended"` | `"resuming"`: non-lifecycle operations
 *     throw `LifecycleOperationBlockedError`
 *
 * @throws {InvalidResponseError} When the response envelope does not match the request type.
 *
 * @example
 * // Branch on lifecycle state before issuing work
 * const current = await state();
 * if (current !== "active") {
 *   await resume();
 * }
 */
export async function state(): Promise<LifecycleState> {
  const response = await send({ type: 'state' })
  if (response.type !== 'state') {
    throw new InvalidResponseError('state')
  }
  return response.state
}
