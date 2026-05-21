import fs from "bare-fs";
import {
  getModel,
  type AnyModel,
} from "@/server/bare/registry/model-registry";
import type {
  FinetuneRunParams,
  FinetuneRunRequest,
  FinetuneProgress,
  FinetuneRequest,
  FinetuneResult,
  FinetuneStats,
  FinetuneStatus,
  FinetuneGetStateRequest,
} from "@/schemas";
import {
  CompletionFailedError,
} from "@/utils/errors-server";
import {
  getRequestRegistry,
  withRequestContext,
} from "@/server/bare/runtime";
import { generateServerRequestId } from "@/server/bare/runtime/request-id";
import { getServerLogger } from "@/logging";

const PAUSE_CHECKPOINT_PREFIX = "pause_checkpoint_step_";

type FinetuneOptions = FinetuneRunParams["options"];

interface AddonFinetuneResult {
  op: "finetune"
  status: "COMPLETED" | "PAUSED"
  stats?: FinetuneStats
}

interface AddonFinetuneHandle {
  on(event: "stats", cb: (stats: FinetuneProgress) => void): AddonFinetuneHandle;
  removeListener(event: "stats", cb: (stats: FinetuneProgress) => void): AddonFinetuneHandle;
  await(): Promise<AddonFinetuneResult>;
}

interface FinetuneCapableModel extends AnyModel {
  finetune(options: FinetuneOptions): Promise<AddonFinetuneHandle>;
  pause(): Promise<void>;
  cancel(): Promise<void>;
}

const finetuneRuntimeState = new Set<string>();

function getRunningFinetuneState(modelId: string) {
  return finetuneRuntimeState.has(modelId);
}

function registerRunningFinetune(modelId: string) {
  finetuneRuntimeState.add(modelId);
}

export function clearFinetuneRuntimeState(modelId: string) {
  finetuneRuntimeState.delete(modelId);
}

export function getFinetuneStateFromCheckpoints(
  options: FinetuneOptions,
): FinetuneStatus {
  const checkpointDirectory = options.checkpointSaveDir ?? "./checkpoints";

  if (!fs.existsSync(checkpointDirectory)) {
    return "IDLE";
  }

  try {
    const entries = fs.readdirSync(checkpointDirectory);

    for (const entry of entries) {
      if (typeof entry !== "string") {
        continue;
      }

      if (
        entry.startsWith(PAUSE_CHECKPOINT_PREFIX)
      ) {
        return "PAUSED";
      }
    }
  } catch (error) {
    throw new CompletionFailedError(
      `Failed to inspect finetune checkpoints in "${checkpointDirectory}"`,
      error,
    );
  }

  return "IDLE";
}

function validateExplicitFinetuneOperation(request: FinetuneRunRequest) {
  if (!request.operation) {
    return;
  }

  const state = getFinetuneStateFromCheckpoints(request.options);

  if (request.operation === "start" && state === "PAUSED") {
    throw new CompletionFailedError(
      `Model "${request.modelId}" has a paused finetune checkpoint; resume it or cancel it before starting from scratch`,
    );
  }

  if (request.operation === "resume" && state === "IDLE") {
    throw new CompletionFailedError(
      `Model "${request.modelId}" has no paused finetune checkpoint to resume`,
    );
  }
}

export async function startFinetune(
  request: FinetuneRunRequest,
  onProgress?: (progress: FinetuneProgress) => void,
): Promise<FinetuneResult> {
  const model = getModel(request.modelId) as FinetuneCapableModel;
  validateExplicitFinetuneOperation(request);

  // Open a request-scoped lifecycle so finetune slots into the same
  // registry-driven cancel surface as the streaming inference kinds.
  // `cancel({ requestId })` and broad `cancel({ modelId, kind: "finetune" })`
  // both route through this context's signal — the `onAbort` listener
  // forwards to `model.cancel()` to match the plugin's
  // `cancel: { scope: "model", hard: true }` declaration. The legacy
  // `cancelFinetune(modelId)` wrapper below now goes through the
  // registry instead of touching the addon directly.
  await using ctx = getRequestRegistry().begin({
    requestId: request.requestId ?? generateServerRequestId(),
    kind: "finetune",
    modelId: request.modelId,
  });
  const requestLogger = withRequestContext(getServerLogger(), ctx);

  registerRunningFinetune(request.modelId);
  // Two-level try/finally collapses into a pair of `scope.defer`
  // registrations. LIFO order — the listener-detach defer is
  // registered after `clearFinetuneRuntimeState`, so on scope unwind
  // the listener is removed first, then the runtime-state flag is
  // cleared. This mirrors the legacy `finally` nesting where the inner
  // `removeListener` ran before the outer `clearFinetuneRuntimeState`.
  ctx.scope.defer(() => {
    clearFinetuneRuntimeState(request.modelId);
  });

  const onAbort = () => {
    model.cancel().catch((err: unknown) => {
      requestLogger.warn(
        `[cancel] model.cancel() rejected during abort for modelId=${request.modelId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  if (ctx.signal.aborted) onAbort();
  ctx.scope.defer(() => {
    ctx.signal.removeEventListener("abort", onAbort);
  });

  const handle = await model.finetune(request.options);

  if (onProgress) {
    handle.on("stats", onProgress);
    ctx.scope.defer(() => {
      handle.removeListener("stats", onProgress);
    });
  }

  const result = await handle.await();

  return {
    type: "finetune",
    status: result.status,
    stats: result.stats,
  };
}

export async function pauseFinetune(modelId: string): Promise<FinetuneResult> {
  const model = getModel(modelId)
  await model.pause();

  return {
    type: "finetune",
    status: "PAUSED",
  };
}

// Thin compat wrapper over the request registry. The in-flight
// finetune is tracked by a `RequestContext` (kind `"finetune"`), and
// the registry owns the broadcast to its `AbortSignal`. `startFinetune`
// installs the addon-level `model.cancel()` listener tied to that
// signal, so callers see the same observable effect as a direct
// `model.cancel()` call. The addon-call wiring is centralised there —
// never invoke `model.cancel()` here.
export function cancelFinetune(modelId: string): Promise<FinetuneResult> {
  // `registry.cancel(...)` is synchronous — it triggers the matching
  // requests' abort signals and returns the cancelled count. Scope
  // unwinding (and the `model.cancel()` forward installed by
  // `startFinetune`) happens on the handler's own dispose path. The
  // outer `Promise.resolve(...)` keeps the legacy `cancelFinetune`
  // return shape (`Promise<FinetuneResult>`) intact for callers.
  getRequestRegistry().cancel({ modelId, kind: "finetune" });

  return Promise.resolve({
    type: "finetune",
    status: "CANCELLED",
  });
}

export function getFinetuneState(params: FinetuneGetStateRequest): FinetuneResult {
  const runtimeState = getRunningFinetuneState(params.modelId);

  return {
    type: "finetune",
    status: runtimeState ? "RUNNING" : getFinetuneStateFromCheckpoints(params.options),
  };
}

export async function finetune(
  request: FinetuneRequest,
  onProgress?: (progress: FinetuneProgress) => void,
): Promise<FinetuneResult> {
  if (
    request.operation === undefined ||
    request.operation === "start" ||
    request.operation === "resume"
  ) {
    return startFinetune(request, onProgress);
  }

  switch (request.operation) {
    case "getState":
      return getFinetuneState(request);
    case "pause":
      return pauseFinetune(request.modelId);
    case "cancel":
      return cancelFinetune(request.modelId);
  }
}
