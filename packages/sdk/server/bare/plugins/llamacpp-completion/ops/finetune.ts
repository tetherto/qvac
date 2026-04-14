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
  registerRunningFinetune(request.modelId);

  try {
    const handle = await model.finetune(request.options);

    if (onProgress) {
      handle.on("stats", onProgress);
    }

    try {
      const result = await handle.await();

      return {
        type: "finetune",
        status: result.status,
        stats: result.stats,
      };
    } finally {
      if (onProgress) {
        handle.removeListener("stats", onProgress);
      }
    }
  } finally {
    clearFinetuneRuntimeState(request.modelId);
  }
}

export async function pauseFinetune(modelId: string): Promise<FinetuneResult> {
  const model = getModel(modelId)
  await model.pause();

  return {
    type: "finetune",
    status: "PAUSED",
  };
}

export async function cancelFinetune(modelId: string): Promise<FinetuneResult> {
  const model = getModel(modelId) as FinetuneCapableModel;
  await model.cancel();

  return {
    type: "finetune",
    status: "CANCELLED",
  };
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
