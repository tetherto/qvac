import { send } from "@/client/rpc/rpc-client";
import { InvalidResponseError } from "@/utils/errors-client";

/**
 * Resumes all suspended Hyperswarm and Corestore resources
 *
 * Idempotent — calling while already active is a no-op.
 * Also serves as the recovery path after a partial suspend failure.
 *
 * @throws {RPCError} When one or more resources fail to resume.
 *
 * @example
 * // Foreground handler
 * await resume();
 */
export async function resume(): Promise<void> {
  const response = await send({ type: "resume" });
  if (response.type !== "resume") {
    throw new InvalidResponseError("resume");
  }
}
