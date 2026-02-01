import { type StopProvideParams, type StopProvideRequest } from "@/schemas";
import { send } from "@/client/rpc/rpc-client";
import {
  InvalidResponseError,
  ProviderStopFailedError,
} from "@/utils/errors-client";

/**
 * Stops a running provider service and leaves the specified topic.
 *
 * @param options - Options object with required topic
 * @param options.topic - Topic hex string to leave
 * @returns A promise that resolves to the stop provide response containing success status
 * @throws {QvacErrorBase} When the response type is not "stopProvide" or the request fails
 */
export async function stopQVACProvider(params: StopProvideParams) {
  const request: StopProvideRequest = {
    type: "stopProvide",
    topic: params.topic,
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
