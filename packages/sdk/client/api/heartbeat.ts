import { type HeartbeatRequest, type HeartbeatResponse } from "@/schemas";
import type { DelegateBase } from "@/schemas/delegate";
import { send } from "@/client/rpc/rpc-client";
import { InvalidResponseError } from "@/utils/errors-client";

/**
 * Checks if a delegated provider is online by sending a heartbeat round-trip.
 * Can also be used to check if the local SDK worker is responsive.
 *
 * @param params - Delegation target to check
 * @param params.delegate - The provider to check (topic + publicKey + optional timeout)
 * @returns A promise that resolves to a heartbeat response if the provider is reachable.
 * @throws {QvacErrorBase} When the provider is unreachable or the response is invalid.
 *
 * @example
 * // Check if a delegated provider is online
 * try {
 *   await heartbeat({
 *     delegate: { topic: "topicHex", providerPublicKey: "peerHex", timeout: 3000 },
 *   });
 *   console.log("Provider is online");
 * } catch {
 *   console.log("Provider is offline");
 * }
 *
 * @example
 * // Check if the local SDK worker is responsive
 * await heartbeat();
 */
export async function heartbeat(params?: {
  delegate?: DelegateBase;
}): Promise<HeartbeatResponse> {
  const request: HeartbeatRequest = {
    type: "heartbeat",
    ...(params?.delegate && { delegate: params.delegate }),
  };

  const response = await send(request);
  if (response.type !== "heartbeat") {
    throw new InvalidResponseError("heartbeat");
  }

  return response;
}

