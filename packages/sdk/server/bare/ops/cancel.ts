import { getModel } from "@/server/bare/registry/model-registry";
import {
  type CancelInferenceBaseParams,
  cancelInferenceBaseSchema,
} from "@/schemas";
import { ModelNotLoadedError } from "@/utils/errors-server";
import { getRequestRegistry } from "@/server/bare/runtime";
import type { RequestKind } from "@/server/bare/runtime";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

/**
 * Broad cancel: abort every in-flight request matching `modelId` (and
 * optionally a `kind`). Maps onto `RequestRegistry.cancel({ modelId })`
 * — the registry walks active contexts and aborts each one's signal,
 * which each handler has wired to its own addon-level / async unwind
 * via the registry's `await using ctx = registry.begin(...)` block.
 *
 * Kept as a stable surface alongside the new `cancel({ requestId })`
 * path: the caller may not have a `requestId` to hand (model unload,
 * app shutdown, admin sweeps), and the escape hatch is cheap because
 * the registry already does the matching.
 *
 * Returns the number of contexts whose abort was triggered by *this*
 * call (already-cancelled contexts are skipped so callers can rely on
 * the count to log "n requests cancelled" once). Used by the RPC
 * cancel handler to populate `CancelResponse.cancelled` and by
 * internal server-side callers that want to know whether anything
 * landed.
 *
 * The legacy pre-registry addon-cancel fallback was removed in 0.11.0
 * once every handler had been migrated onto the registry; the function
 * now does exactly one thing — a registry walk.
 */
export function cancel(
  params: CancelInferenceBaseParams,
  opts?: { kind?: RequestKind },
): number {
  const { modelId } = cancelInferenceBaseSchema.parse(params);
  const model = getModel(modelId);

  if (!model) {
    throw new ModelNotLoadedError(modelId);
  }

  const registry = getRequestRegistry();
  const target = opts?.kind ? { modelId, kind: opts.kind } : { modelId };
  const cancelled = registry.cancel(target);

  if (cancelled === 0) {
    // Callers (workbench "Stop" button, app shutdown sweeps) often
    // fire-and-forget; log so operators can see when a broad cancel
    // landed against a registry with nothing in flight on this model.
    logger.debug(
      `[cancel] no in-flight request matched modelId=${modelId}${opts?.kind ? ` kind=${opts.kind}` : ""}`,
    );
  }

  return cancelled;
}
