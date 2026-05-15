import type { CancelRequest, CancelResponse } from "@/schemas/cancel";
import { cancel as cancelByModelId } from "@/server/bare/ops/cancel";
import { getRequestRegistry } from "@/server/bare/runtime";
import { markClearCacheForRequest } from "@/server/rpc/handlers/load-model/download-manager";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

/**
 * Cancel RPC entry point. The 5-arm `switch (request.operation)`
 * dispatcher that lived here through 0.10.x was retired in 0.11.0:
 * every long-running handler now registers itself on the
 * worker-singleton `RequestRegistry`, so the cancel surface narrows to
 * two paths that route through the same registry primitive:
 *
 *  - `{ operation: "request", requestId, clearCache? }` — targeted
 *    cancel by client-generated id. Looks up the registry entry,
 *    fires its abort signal, optionally marks the underlying download
 *    transfer for cache clear. The "stop-button race" case (client
 *    cancel beats its own begin to the worker) is handled inside the
 *    registry via the cancel-before-begin tripwire.
 *
 *  - `{ operation: "broad", modelId, kind? }` — abort every in-flight
 *    request on a model (optionally narrowed by `kind`). Used for
 *    model unload, app shutdown, and admin sweeps where the caller
 *    has no `requestId`. Delegates to the `cancel` bare op so the
 *    `ModelNotLoadedError` validation is shared with internal
 *    server-side broad cancels.
 *
 * Always returns `success: true` plus a `cancelled` count (the number
 * of contexts this call flipped to `cancelling` — already-cancelled
 * contexts are not counted). A targeted cancel with no in-flight
 * match still returns `success: true, cancelled: 0`; the
 * cancel-before-begin tripwire ensures the cancel is applied
 * retroactively if a matching begin arrives within the registry's
 * race window.
 */
export function cancelHandler(request: CancelRequest): CancelResponse {
  try {
    if (request.operation === "request") {
      if (request.clearCache) {
        markClearCacheForRequest(request.requestId);
      }
      const cancelled = getRequestRegistry().cancel({
        requestId: request.requestId,
      });
      if (cancelled === 0) {
        // info-level (not debug) because the decorated-promise pattern
        // makes "no in-flight match" a common and user-visible case:
        // a Stop button fired after the request settled but before
        // the UI cleared lands here. The cancel-before-begin tripwire
        // inside the registry already captured the cancel for any
        // matching begin in flight; this log just helps operators
        // debugging "my Stop button isn't working" without lowering
        // the log level.
        logger.info(
          `[cancel] no in-flight request matched requestId=${request.requestId}`,
        );
      }
      return { type: "cancel", success: true, cancelled };
    }

    // operation === "broad"
    const cancelled = cancelByModelId(
      { modelId: request.modelId },
      request.kind ? { kind: request.kind } : undefined,
    );
    return { type: "cancel", success: true, cancelled };
  } catch (error) {
    logger.error("Error during cancellation:", error);
    return {
      type: "cancel",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
