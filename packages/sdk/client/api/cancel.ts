import { send } from "@/client/rpc/rpc-client";
import {
  type CancelClientInput,
  type CancelParams,
  type CancelRequest,
} from "@/schemas";
import { InvalidResponseError, CancelFailedError } from "@/utils/errors-client";

/**
 * Cancels an ongoing operation.
 *
 * Two cancel paths are supported:
 *
 *  - **By `requestId`** (introduced in 0.11.0, primary path) — pass the
 *    `requestId` exposed on the result of a long-running call (e.g.
 *    `(await completion({ ... })).requestId`) to cancel exactly that
 *    request. Either pass `{ requestId }` directly or the explicit
 *    `{ operation: "request", requestId }` form; both are equivalent.
 *    The cancel takes effect once the server has begun the request; a
 *    cancel that races the originating call to the worker may arrive
 *    before the request is registered and is logged as a no-match.
 *  - **By `modelId`** (broad-cancel escape hatch, kept indefinitely) —
 *    `{ operation: "inference" | "embeddings", modelId }` cancels every
 *    in-flight request running on that model. Useful for model unload,
 *    app shutdown, or "cancel everything" admin paths where the caller
 *    doesn't have a `requestId` to hand.
 *
 * The download and RAG cancel paths are unchanged in 0.11.0; they still
 * route through their own existing handlers.
 *
 * @param params - The parameters for the cancellation
 * @throws {QvacErrorBase} When the response type is invalid or when the cancellation fails
 *
 * @example
 * // Cancel a specific completion by requestId (new in 0.11.0)
 * const run = completion({ ... });
 * await cancel({ requestId: run.requestId });
 *
 * @example
 * // Broad-cancel every inference running on a model (escape hatch)
 * await cancel({ operation: "inference", modelId: "model-123" });
 *
 * @example
 * // Pause download (preserves partial file for automatic resume)
 * await cancel({ operation: "downloadAsset", downloadKey: "download-key" });
 *
 * @example
 * // Cancel download completely (deletes partial file)
 * await cancel({ operation: "downloadAsset", downloadKey: "download-key", clearCache: true });
 *
 * @example
 * // Cancel delegated remote download
 * await cancel({
 *   operation: "downloadAsset",
 *   downloadKey: "download-key",
 *   delegate: { providerPublicKey: "peerHex" },
 * });
 *
 * @example
 * // Cancel RAG operation on default workspace
 * await cancel({ operation: "rag" });
 *
 * @example
 * // Cancel RAG operation on specific workspace
 * await cancel({ operation: "rag", workspace: "my-workspace" });
 */
export async function cancel(params: CancelClientInput) {
  const wireParams = normalizeCancelParams(params);
  const request: CancelRequest = {
    type: "cancel",
    ...wireParams,
  };

  const response = await send(request);
  if (response.type !== "cancel") {
    throw new InvalidResponseError("cancel");
  }

  if (!response.success) {
    throw new CancelFailedError(response.error);
  }
}

function normalizeCancelParams(params: CancelClientInput): CancelParams {
  if (!("operation" in params) && "requestId" in params) {
    return { operation: "request", requestId: params.requestId };
  }
  return params;
}
