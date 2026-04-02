import {
  getModel,
  type AnyModel,
} from "@/server/bare/registry/model-registry";
import type {
  FinetuneProgress,
  FinetuneRequest,
  FinetuneResult,
  FinetuneStats,
} from "@/schemas";
import {
  CancelFailedError,
  CompletionFailedError,
} from "@/utils/errors-server";

type FinetuneRunRequest = Extract<
  FinetuneRequest,
  { operation: "start" | "resume" }
>;

type FinetuneOptions = FinetuneRunRequest["options"];

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

function getFinetuneModel(modelId: string) {
  const model = getModel(modelId) as FinetuneCapableModel;

  if (typeof model.finetune !== "function") {
    throw new CompletionFailedError(
      `Model "${modelId}" does not support finetuning`,
    );
  }

  if (typeof model.pause !== "function" || typeof model.cancel !== "function") {
    throw new CancelFailedError(
      `Model "${modelId}" does not support finetune controls`,
    );
  }

  return model;
}

export async function startFinetune(
  request: Extract<FinetuneRequest, { operation: "start" | "resume" }>,
  onProgress?: (progress: FinetuneProgress) => void,
): Promise<FinetuneResult> {
  const model = getFinetuneModel(request.modelId);
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
}

export async function pauseFinetune(modelId: string): Promise<FinetuneResult> {
  const model = getFinetuneModel(modelId);
  await model.pause();

  return {
    type: "finetune",
    status: "PAUSED",
  };
}

export async function cancelFinetune(modelId: string): Promise<FinetuneResult> {
  const model = getFinetuneModel(modelId);
  await model.cancel();

  return {
    type: "finetune",
    status: "CANCELLED",
  };
}

export async function finetune(
  request: FinetuneRequest,
  onProgress?: (progress: FinetuneProgress) => void,
): Promise<FinetuneResult> {
  switch (request.operation) {
    case "start":
    case "resume":
      return startFinetune(request, onProgress);
    case "pause":
      return pauseFinetune(request.modelId);
    case "cancel":
      return cancelFinetune(request.modelId);
  }
}
