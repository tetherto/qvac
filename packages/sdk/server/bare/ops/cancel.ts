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
 *
 * Compatibility fallback: only the llama.cpp completion handler routes
 * through the registry in 0.11.0; embeddings / transcription /
 * translation / decoder / OCR / TTS handlers will follow in later
 * milestones. Until then, a `modelId`-targeted cancel that finds zero
 * registry matches falls back to the pre-0.11.0 behavior of calling
 * `model.addon.cancel()` directly, so the wire contract for those
 * surfaces does not regress while the migration is in flight.
 */
export async function cancel(
  params: CancelInferenceBaseParams,
  opts?: { kind?: RequestKind },
): Promise<void> {
  const { modelId } = cancelInferenceBaseSchema.parse(params);
  const model = getModel(modelId);

  if (!model) {
    throw new ModelNotLoadedError(modelId);
  }

  const registry = getRequestRegistry();
  const target = opts?.kind ? { modelId, kind: opts.kind } : { modelId };
  const cancelled = registry.cancel(target);

  if (cancelled > 0) return;

  // No registry match: a request kind whose handler hasn't been migrated
  // onto `registry.begin(...)` yet (everything except llama.cpp
  // completion in 0.11.0). Fire the addon-level cancel directly so the
  // pre-registry behavior is preserved — including awaiting acknowledgement,
  // which is the wire contract callers relied on before this PR (the RPC
  // response resolves once the addon has flipped its cancel flag, not
  // beforehand).
  const addon = model.addon;
  if (addon?.cancel) {
    await addon.cancel.call(addon);
    logger.debug(
      `[cancel] no registry match for modelId=${modelId}${opts?.kind ? ` kind=${opts.kind}` : ""} — fell back to addon.cancel()`,
    );
    return;
  }

  // Callers (workbench "Stop" button, app shutdown sweeps) often
  // fire-and-forget; log so operators can see when a cancel landed
  // against a registry with nothing in flight and no addon-level cancel.
  logger.debug(
    `[cancel] no in-flight request matched modelId=${modelId}${opts?.kind ? ` kind=${opts.kind}` : ""}`,
  );
}
