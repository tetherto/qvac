import { send } from "@/client/rpc/rpc-client";
import { InvalidResponseError } from "@/utils/errors-client";

/**
 * Resumes the SDK runtime: restores all suspended Hyperswarm and Corestore
 * resources and releases the lifecycle gate so all SDK operations are allowed
 * again.
 *
 * Safe to call from any lifecycle state — `resume()` is never blocked by the
 * lifecycle gate (along with `suspend()` and `state()`). Idempotent. Also
 * serves as the recovery path after a partial suspend failure.
 *
 * After `resume()` resolves successfully, runtime state is `"active"` and
 * non-lifecycle SDK operations are accepted normally.
 *
 * Behavior of in-flight operations from before the previous `suspend()`:
 *   - P2P / Hyperdrive downloads: continue automatically once their underlying
 *     swarm/corestore is restored
 *   - Delegated reply RPCs: auto-recover once the swarm reconnects
 *     (subject to delegate `timeout`)
 *   - Delegated stream RPCs: not recovered — re-issue after `resume()` works normally.
 *
 * @throws {RPCError} When one or more resources fail to resume. On partial
 *   failure the runtime stays `"suspended"` (operations remain blocked) so
 *   callers can retry `resume()`.
 *
 * @example
 * // Foreground handler
 * await resume();
 * console.log(await state()); // "active"
 */
export async function resume(): Promise<void> {
  const response = await send({ type: "resume" });
  if (response.type !== "resume") {
    throw new InvalidResponseError("resume");
  }
}
