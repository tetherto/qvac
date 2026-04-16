import { send } from "@/client/rpc/rpc-client";
import { InvalidResponseError } from "@/utils/errors-client";

/**
 * Suspends all active Hyperswarm and Corestore resources
 *
 * Idempotent — calling while already suspended is a no-op.
 *
 * @throws {RPCError} When one or more resources fail to suspend (partial failure).
 *
 * @example
 * // Background handler
 * await suspend();
 */
export async function suspend(): Promise<void> {
  const response = await send({ type: "suspend" });
  if (response.type !== "suspend") {
    throw new InvalidResponseError("suspend");
  }
}
