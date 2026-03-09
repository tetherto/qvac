import { type PingRequest } from "@/schemas";
import { send } from "@/client/rpc/rpc-client";
import { InvalidResponseError } from "@/utils/errors-client";

/**
 * Sends a ping request to the server and returns the pong response.
 *
 * @returns A promise that resolves to a pong response containing a number.
 * @throws {QvacErrorBase} When the response type is not "pong".
 */
export async function ping() {
  const request: PingRequest = {
    type: "ping",
  };

  const response = await send(request);
  if (response.type !== "pong") {
    throw new InvalidResponseError("pong");
  }

  return response;
}
