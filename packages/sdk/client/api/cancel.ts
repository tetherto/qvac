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
 *  - **By `requestId`** (primary) — pass the `requestId` exposed on
 *    the result of a long-running call (`completion(...)`,
 *    `loadModel(...)`, `downloadAsset(...)`, `embed(...)`,
 *    `transcribe(...)`, `ragIngest(...)`, etc.) to cancel exactly
 *    that request. A cancel that races the originating call is
 *    recorded and applied retroactively when the begin arrives.
 *  - **Broad by `modelId`** (escape hatch) — `{ modelId, kind? }`
 *    cancels every in-flight request on that model. Useful for
 *    model unload, app shutdown, or admin sweeps where the caller
 *    doesn't have a `requestId` to hand.
 *
 * The legacy `{ operation: "inference" | "embeddings", modelId }`
 * sugars remain callable for source compatibility. For migration off
 * the removed `{ operation: "downloadAsset" | "rag" }` shapes, see
 * the 0.11.0 changelog / release notes.
 *
 * @param params - The cancellation parameters.
 * @throws {QvacErrorBase} When the response type is invalid or the cancellation fails.
 *
 * @example
 * // Cancel by requestId (primary path)
 * const run = completion({ ... });
 * await cancel({ requestId: run.requestId });
 *
 * @example
 * // Broad-cancel every inference running on a model
 * await cancel({ modelId: "model-123", kind: "completion" });
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
  if ("operation" in params) {
    if (params.operation === "request" || params.operation === "broad") {
      return params;
    }
    // Legacy per-kind sugar: { operation: "inference"|"embeddings", modelId }
    if (params.operation === "inference") {
      return {
        operation: "broad",
        modelId: params.modelId,
        kind: "completion",
      };
    }
    return { operation: "broad", modelId: params.modelId, kind: "embeddings" };
  }

  if ("requestId" in params) {
    const wire: CancelParams = {
      operation: "request",
      requestId: params.requestId,
    };
    if (params.clearCache !== undefined) {
      wire.clearCache = params.clearCache;
    }
    return wire;
  }

  const broad: CancelParams = {
    operation: "broad",
    modelId: params.modelId,
  };
  if (params.kind !== undefined) {
    broad.kind = params.kind;
  }
  return broad;
}
