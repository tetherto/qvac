import {
  type GetLoadedModelInfoParams,
  type GetLoadedModelInfoRequest,
  type LoadedModelInfo,
} from "@/schemas";
import { type RPCOptions } from "@/schemas/common";
import { send } from "@/client/rpc/rpc-client";
import { InvalidResponseError } from "@/utils/errors-client";

/**
 * Returns introspection info for a loaded `modelId` (local or delegated).
 *
 * For local models, `info.modelType` and `info.handlers` are authoritative.
 * Use them to preflight an SDK call before sending the actual RPC, e.g.
 * confirm that a model supports `transcribeStream` before calling `transcribe()`.
 *
 * For delegated models, only `modelId`, `isDelegated: true`, `providerInfo`,
 * and `handlers: []` are populated. Preflight against a delegated model is
 * best-effort and falls through to the provider's error response.
 *
 * Throws `ModelNotFoundError` if no entry exists for `modelId`.
 *
 * @example
 * ```typescript
 * const info = await getLoadedModelInfo({ modelId });
 * if (info.isDelegated || info.handlers.includes("completionStream")) {
 *   // safe to call completion(); delegated path defers to provider
 * }
 * ```
 */
export async function getLoadedModelInfo(
  params: GetLoadedModelInfoParams,
  rpcOptions?: RPCOptions,
): Promise<LoadedModelInfo> {
  const request: GetLoadedModelInfoRequest = {
    type: "getLoadedModelInfo",
    modelId: params.modelId,
  };

  const response = await send(request, rpcOptions);
  if (response.type !== "getLoadedModelInfo") {
    throw new InvalidResponseError("getLoadedModelInfo");
  }

  return response.info;
}
