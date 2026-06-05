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

  // Mark RUNNING before the async begin() so an immediate getFinetuneState()
  // poll observes RUNNING, not IDLE. register is a no-op when a finetune is
  // already running on this model, so only clear on a failed begin() if this
  // call actually set the flag.
  const wasRunning = getRunningFinetuneState(request.modelId);
  registerRunningFinetune(request.modelId);

  // Scope the run into the registry so cancel({ requestId }) and
  // cancel({ modelId, kind: "finetune" }) reach it; onAbort forwards to
  // model.cancel().
  await using ctx = await getRequestRegistry()
    .begin({
      requestId: request.requestId ?? generateServerRequestId(),
      kind: "finetune",
      modelId: request.modelId,
    })
    .catch((err: unknown) => {
      if (!wasRunning) clearFinetuneRuntimeState(request.modelId);
      throw err;
    });
  const requestLogger = withRequestContext(getServerLogger(), ctx);
  // Cleared on scope unwind; deferred before the listener detach so LIFO
  // removes the listener first.
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

// Routes cancellation through the registry; the model.cancel() forward is
// installed by startFinetune, so never call model.cancel() here.
export function cancelFinetune(modelId: string): Promise<FinetuneResult> {
  // cancel() is synchronous; Promise.resolve keeps the Promise<FinetuneResult>
  // return shape.
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
