import type { CancelRequest, CancelResponse } from '@/schemas/cancel'
import { cancel as cancelByModelId } from '@/plugins/ops/cancel'
import { getRequestRegistry } from '@/runtime/index'
import { resolveSessionId } from '@/runtime/session-id'
import { markClearCacheForRequest } from '@/handlers/load-model/download-manager'
import { getEngineLogger } from '@/logging/index'

const logger = getEngineLogger()

/**
 * Cancel handler entry point. Every long-running handler registers
 * itself on the process-singleton `RequestRegistry`, so the cancel
 * surface is two paths that route through the same registry primitive:
 *
 *  - `{ operation: "request", requestId, clearCache? }` — targeted
 *    cancel by caller-generated id, resolved within the caller's own
 *    session. Looks up the registry entry, fires its abort signal,
 *    optionally marks the underlying download transfer for cache clear.
 *    The "stop-button race" case (a cancel beats its own begin) is
 *    handled inside the registry via the cancel-before-begin tripwire.
 *
 *  - `{ operation: "broad", modelId, kind? }` — abort every in-flight
 *    request the caller's session has on a model (optionally narrowed
 *    by `kind`). From the owner session it reaches every session's
 *    requests on the model. Delegates to the `cancel` bare op so the
 *    `ModelNotLoadedError` validation is shared with internal
 *    engine-side broad cancels.
 *
 * Always returns `success: true` plus a `cancelled` count (the number
 * of contexts this call flipped to `cancelling` — already-cancelled
 * contexts are not counted). A targeted cancel with no in-flight
 * match still returns `success: true, cancelled: 0`; the
 * cancel-before-begin tripwire ensures the cancel is applied
 * retroactively if a matching begin arrives within the registry's
 * race window. Another session's request id is such a non-match: the
 * registry keys requests by `(sessionId, requestId)`, so it is never found.
 */
export function cancelHandler(request: CancelRequest): CancelResponse {
  const sessionId = resolveSessionId(request)
  try {
    if (request.operation === 'request') {
      if (request.clearCache) {
        markClearCacheForRequest(request.requestId, sessionId)
      }
      const cancelled = getRequestRegistry().cancel({
        requestId: request.requestId,
        sessionId
      })
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
          `[cancel] no in-flight request matched sessionId=${sessionId} requestId=${request.requestId}`
        )
      }
      return { type: 'cancel', success: true, cancelled }
    }

    // operation === "broad"
    const cancelled = cancelByModelId(
      { modelId: request.modelId },
      { ...(request.kind && { kind: request.kind }), sessionId }
    )
    return { type: 'cancel', success: true, cancelled }
  } catch (error) {
    logger.error('Error during cancellation:', error)
    return {
      type: 'cancel',
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}
