import { type PingRequest, type PingResponse } from "@/schemas";
import type { DelegateBase } from "@/schemas/delegate";
import { send } from "@/client/rpc/rpc-client";
import { InvalidResponseError } from "@/utils/errors-client";

/**
 * Sends a ping request to the server and returns the pong response.
 * Optionally pings a delegated provider.
 *
 * @param params - Optional parameters for delegated ping
 * @param params.delegate - Delegation target to ping a remote provider
 * @returns A promise that resolves to a pong response containing a number.
 * @throws {QvacErrorBase} When the response type is not "pong".
 *
 * @example
 * // Ping the local SDK worker
 * const pong = await ping();
 *
 * @example
 * // Ping a delegated provider
 * const pong = await ping({
 *   delegate: { topic: "topicHex", providerPublicKey: "peerHex", timeout: 3000 },
 * });
 */
export async function ping(params?: { delegate?: DelegateBase }): Promise<PingResponse> {
  const request: PingRequest = {
    type: "ping",
    ...(params?.delegate && { delegate: params.delegate }),
  };

  const response = await send(request);
  if (response.type !== "pong") {
    throw new InvalidResponseError("pong");
  }

  return response;
}
