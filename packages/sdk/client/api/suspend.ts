import { send } from "@/client/rpc/rpc-client";
import { InvalidResponseError } from "@/utils/errors-client";

/**
 * Suspends the SDK runtime: pauses all registered Hyperswarm and Corestore
 * resources and engages the lifecycle gate so non-lifecycle operations are
 * blocked until `resume()` is called.
 *
 * Safe to call from any lifecycle state — `suspend()` is never blocked by the
 * lifecycle gate (along with `resume()` and `state()`). Idempotent.
 *
 * After `suspend()` resolves, runtime state is `"suspended"` and any non-
 * lifecycle SDK operation throws `LifecycleOperationBlockedError` until
 * `resume()` is called.
 *
 * In-flight operations started before suspend:
 *   - P2P / Hyperdrive downloads: stall cleanly, continue after `resume()`
 *   - HTTP downloads: bypass suspend entirely (bytes keep flowing)
 *   - Local native inference: runs to completion regardless
 *   - Delegated reply RPCs: stall, then auto-recover after `resume()`
 *     (subject to delegate `timeout`)
 *   - Delegated stream RPCs: severed, consumer iterator hangs silently;
 *     re-issue after `resume()` works normally.
 *
 * @throws {RPCError} When one or more resources fail to suspend. The runtime
 *   still commits to `"suspended"` so callers can recover with `resume()`.
 *
 * @example
 * // Background handler
 * await suspend();
 * console.log(await state()); // "suspended"
 */
export async function suspend(): Promise<void> {
  const response = await send({ type: "suspend" });
  if (response.type !== "suspend") {
    throw new InvalidResponseError("suspend");
  }
}
