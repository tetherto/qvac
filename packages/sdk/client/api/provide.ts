import { type ProvideParams, type ProvideRequest } from "@/schemas";
import { send } from "@/client/rpc/rpc-client";
import {
  InvalidResponseError,
  ProviderStartFailedError,
} from "@/utils/errors-client";

/**
 * Starts a provider service that offers QVAC capabilities to remote peers.
 *
 * Consumers connect directly to the provider via its public key using
 * `dht.connect(publicKey)`, so no topic or discovery configuration is needed.
 * The provider's keypair (and therefore its public key) can be controlled via
 * the `QVAC_HYPERSWARM_SEED` environment variable.
 *
 * Idempotent: calling more than once while a provider is already running
 * returns the same public key without re-listening on the DHT.
 *
 * @param params - Options object with optional firewall config
 * @param params.firewall - Optional firewall configuration to allow/deny specific public keys
 * @returns A promise that resolves to the provide response containing success status and public key
 * @throws {QvacErrorBase} When the response type is not "provide" or the request fails
 */
export async function startQVACProvider(params: ProvideParams = {}) {
  const request: ProvideRequest = {
    type: "provide",
    firewall: params.firewall,
  };

  const response = await send(request);
  if (response.type !== "provide") {
    throw new InvalidResponseError("provide");
  }

  if (response.error) {
    throw new ProviderStartFailedError(response.error);
  }

  return response;
}
