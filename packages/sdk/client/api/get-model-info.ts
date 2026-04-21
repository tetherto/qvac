import { type GetModelInfoRequest, type GetModelInfoParams } from "@/schemas";
import { send } from "@/client/rpc/rpc-client";
import { InvalidResponseError } from "@/utils/errors-client";

/**
 * Retrieves detailed information about a model, including cache status and
 * loaded instances.
 *
 * @param params - The query parameters
 * @param params.name - The model name to look up
 * @returns Detailed information about the model (cache status, loaded instances,
 *   size, checksum, engine, etc.).
 *
 * @throws {INVALID_RESPONSE_TYPE} Response type does not match expected `"getModelInfo"`
 *
 * @example
 * ```typescript
 * import { getModelInfo } from "@qvac/sdk";
 *
 * const info = await getModelInfo({ name: "Llama 3.2 3B Q4" });
 * console.log(`Cached: ${info.isCached}, Loaded: ${info.isLoaded}`);
 * console.log(`Size: ${info.expectedSize} bytes`);
 * ```
 */
export async function getModelInfo(params: GetModelInfoParams) {
  const request: GetModelInfoRequest = {
    type: "getModelInfo",
    name: params.name,
  };

  const response = await send(request);
  if (response.type !== "getModelInfo") {
    throw new InvalidResponseError("getModelInfo");
  }

  return response.modelInfo;
}
