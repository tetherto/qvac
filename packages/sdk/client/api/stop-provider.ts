import { type StopProvideRequest } from "@/schemas";
import { send } from "@/client/rpc/rpc-client";
import {
  InvalidResponseError,
  ProviderStopFailedError,
} from "@/utils/errors-client";

/**
 * Stops the running provider service.
 *
 * After this call returns, incoming peer connections are dropped at the RPC
 * layer and remote `loadModel`/`completion`/etc. requests will no longer be
 * served. The keyPair stays bound on the DHT (a `swarm.listen()` cannot be
 * undone without tearing down the shared swarm), so peers may still open a
 * raw socket — but those sockets are immediately destroyed and no RPC server
 * is mounted on them.
 *
 * Idempotent: calling more than once with no provider running is a no-op.
 *
 * @returns A promise that resolves to the stop provide response containing success status
 * @throws {QvacErrorBase} When the response type is not "stopProvide" or the request fails
 */
export async function stopQVACProvider() {
  const request: StopProvideRequest = {
    type: "stopProvide",
  };

  const response = await send(request);
  if (response.type !== "stopProvide") {
    throw new InvalidResponseError("stopProvide");
  }

  if (response.error) {
    throw new ProviderStopFailedError(response.error);
  }

  return response;
}
