import { type ProvideParams, type ProvideRequest } from "@/schemas";
import { send } from "@/client/rpc/rpc-client";
import {
  InvalidResponseError,
  ProviderStartFailedError,
} from "@/utils/errors-client";

/**
 * Starts a provider service that offers QVAC capabilities to remote peers.
 * The provider's keypair can be controlled via the seed option or QVAC_HYPERSWARM_SEED environment variable.
 *
 * @param options - Options object with required topic, optional seed, and optional firewall config
 * @param options.topic - Topic hex string for peer discovery
 * @param options.firewall - Optional firewall configuration to allow/deny specific public keys
 * @returns A promise that resolves to the provide response containing success status and public key
 * @throws {QvacErrorBase} When the response type is not "provide" or the request fails
 */
export async function startQVACProvider(params: ProvideParams) {
  const request: ProvideRequest = {
    type: "provide",
    topic: params.topic,
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
