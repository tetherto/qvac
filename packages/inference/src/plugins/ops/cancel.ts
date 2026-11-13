import { getModel } from '@/runtime/model-registry'
import { type CancelInferenceBaseParams, cancelInferenceBaseSchema } from '@/schemas/index'
import { ModelNotLoadedError } from '@/errors/index'
import { getRequestRegistry } from '@/runtime/index'
import type { RequestKind } from '@/runtime/index'
import { OWNER_SESSION_ID } from '@/runtime/session-id'
import { isOwnerSession } from '@/runtime/session-registry'
import { getEngineLogger } from '@/logging/index'

const logger = getEngineLogger()

/**
 * Broad cancel: abort every in-flight request matching `modelId` (and
 * optionally a `kind`). Maps onto `RequestRegistry.cancel({ modelId })`
 * — the registry walks active contexts and aborts each one's signal,
 * which each handler has wired to its own addon-level / async unwind
 * via the registry's `await using ctx = await registry.begin(...)` block.
 *
 * Kept as a stable surface alongside the new `cancel({ requestId })`
 * path: the caller may not have a `requestId` to hand (model unload,
 * app shutdown, admin sweeps), and the escape hatch is cheap because
 * the registry already does the matching.
 *
 * Returns the number of contexts whose abort was triggered by *this*
 * call (already-cancelled contexts are skipped so callers can rely on
 * the count to log "n requests cancelled" once). Used by the cancel
 * handler to populate `CancelResponse.cancelled` and by internal
 * callers that want to know whether anything landed.
 *
 * The function does exactly one thing — a registry walk.
 */
export function cancel(
  params: CancelInferenceBaseParams,
  opts?: { kind?: RequestKind; sessionId?: string }
): number {
  const { modelId } = cancelInferenceBaseSchema.parse(params)
  const model = getModel(modelId)

  if (!model) {
    throw new ModelNotLoadedError(modelId)
  }

  // The owner sweeps every session's requests on the model; a session only
  // reaches its own.
  const sessionId = opts?.sessionId ?? OWNER_SESSION_ID
  const registry = getRequestRegistry()
  const cancelled = registry.cancel({
    modelId,
    ...(opts?.kind && { kind: opts.kind }),
    sessionId,
    allSessions: isOwnerSession(sessionId)
  })

  if (cancelled === 0) {
    // Callers (workbench "Stop" button, app shutdown sweeps) often
    // fire-and-forget; log so operators can see when a broad cancel
    // landed against a registry with nothing in flight on this model.
    logger.debug(
      `[cancel] no in-flight request matched modelId=${modelId}${opts?.kind ? ` kind=${opts.kind}` : ''}`
    )
  }

  return cancelled
}
