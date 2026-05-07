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
 * which the inference handler has wired to the addon's `cancel()`.
 *
 * Kept as a stable surface alongside the new `cancel({ requestId })`
 * path: the caller may not have a `requestId` to hand (model unload,
 * app shutdown, admin sweeps), and the escape hatch is cheap because
 * the registry already does the matching.
 */
export function cancel(
  params: CancelInferenceBaseParams,
  opts?: { kind?: RequestKind },
) {
  const { modelId } = cancelInferenceBaseSchema.parse(params);
  const model = getModel(modelId);

  if (!model) {
    throw new ModelNotLoadedError(modelId);
  }

  const registry = getRequestRegistry();
  const target = opts?.kind
    ? { modelId, kind: opts.kind }
    : { modelId };
  const cancelled = registry.cancel(target);

  // No active request to cancel is not a hard error — callers (workbench
  // "Stop" button, app shutdown sweeps) often fire-and-forget. Log so
  // operators can see when a cancel landed against an empty registry.
  if (cancelled === 0) {
    logger.debug(
      `[cancel] no in-flight request matched modelId=${modelId}${opts?.kind ? ` kind=${opts.kind}` : ""}`,
    );
  }
}
