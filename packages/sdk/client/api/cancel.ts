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
 * Two cancel paths are supported in 0.11.0+:
 *
 *  - **By `requestId`** (primary path) — pass the `requestId` exposed
 *    on the result of a long-running call (e.g.
 *    `(await completion({ ... })).requestId`,
 *    `loadModel(...).requestId`, `downloadAsset(...).requestId`,
 *    `embed(...).requestId`, `transcribe(...).requestId`) to cancel
 *    exactly that request. Either pass `{ requestId }` directly or
 *    the explicit `{ operation: "request", requestId }` form; both
 *    are equivalent. The cancel takes effect once the server has
 *    begun the request; a cancel that races the originating call to
 *    the worker is recorded and applied retroactively when the begin
 *    arrives, so it is not silently dropped.
 *  - **Broad cancel by `modelId`** (escape hatch, kept indefinitely) —
 *    `{ modelId, kind? }` (or the explicit `{ operation: "broad",
 *    modelId, kind? }` form) cancels every in-flight request running
 *    on that model. Useful for model unload, app shutdown, or
 *    "cancel everything" admin paths where the caller doesn't have a
 *    `requestId` to hand. The legacy `{ operation: "inference",
 *    modelId }` and `{ operation: "embeddings", modelId }` forms
 *    remain callable and translate to the broad-cancel shape with the
 *    appropriate `kind`.
 *
 * In 0.11.0 the wire envelope for cancel narrowed from a 5-arm
 * discriminated union (`"inference" | "embeddings" | "downloadAsset" |
 * "rag" | "request"`) to a 2-arm union (`"request" | "broad"`). The
 * public-API surface above is unchanged for `cancel({ modelId })` /
 * `cancel({ requestId })` consumers; the legacy per-kind sugars are
 * retained at the client boundary so callers using
 * `cancel({ operation: "inference", modelId })` keep working without
 * code changes.
 *
 * **Migration notes:**
 *  - `cancel({ operation: "downloadAsset", downloadKey, clearCache })`
 *    is removed. Hold onto the `requestId` from `downloadAsset(...)`
 *    (decorated promise) and call `cancel({ requestId, clearCache })`
 *    instead. The `clearCache` flag is honoured on the `requestId`
 *    path for download requests.
 *  - `cancel({ operation: "rag", workspace })` is removed. The three
 *    cancellable RAG operations (`ragIngest(...)`, `ragSaveEmbeddings(...)`,
 *    `ragReindex(...)`) all return decorated promises in 0.11.0;
 *    hold onto `op.requestId` and call `cancel({ requestId })` to
 *    target a specific in-flight RAG op. For "cancel everything RAG"
 *    sweeps without a `requestId` to hand, use the broad-cancel
 *    escape hatch `cancel({ modelId: <embeddingModelId>, kind: "rag" })`.
 *    Note: the non-cancellable RAG ops (`ragChunk(...)`, `ragSearch(...)`,
 *    `ragDeleteEmbeddings(...)`, workspace lifecycle) intentionally do
 *    not decorate — they're fast-path operations that don't register
 *    with the request registry server-side.
 *
 * @param params - The parameters for the cancellation
 * @throws {QvacErrorBase} When the response type is invalid or when the cancellation fails
 *
 * @example
 * // Cancel a specific completion by requestId (primary path)
 * const run = completion({ ... });
 * await cancel({ requestId: run.requestId });
 *
 * @example
 * // Cancel a specific download by requestId, deleting the partial file
 * const op = downloadAsset({ assetSrc, onProgress });
 * await cancel({ requestId: op.requestId, clearCache: true });
 *
 * @example
 * // Broad-cancel every inference running on a model (escape hatch)
 * await cancel({ modelId: "model-123", kind: "completion" });
 *
 * @example
 * // Same call via the legacy per-kind sugar (still supported)
 * await cancel({ operation: "inference", modelId: "model-123" });
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
