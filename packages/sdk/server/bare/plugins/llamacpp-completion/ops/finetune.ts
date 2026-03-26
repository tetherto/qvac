import type {
  FinetuneRequest,
  FinetuneStartRequest,
  FinetuneResponse,
  FinetuneProgress,
  FinetuneStats,
} from "@/schemas";
import {
  getModel,
  type AnyModel,
} from "@/server/bare/registry/model-registry";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

interface FinetuneProgressStats {
  is_train: boolean;
  loss: number;
  loss_uncertainty: number;
  accuracy: number;
  accuracy_uncertainty: number;
  global_steps: number;
  current_epoch: number;
  current_batch: number;
  total_batches: number;
  elapsed_ms: number;
  eta_ms: number;
}

interface FinetuneHandle {
  on(event: "stats", cb: (stats: FinetuneProgressStats) => void): this;
  removeListener(
    event: "stats",
    cb: (stats: FinetuneProgressStats) => void,
  ): this;
  await(): Promise<{ op: string; status: "COMPLETED" | "PAUSED"; stats?: unknown }>;
}

function getFinetuneFn(model: AnyModel) {
  const fn = (model as Record<string, unknown>)["finetune"];
  return typeof fn === "function"
    ? (fn as (options: Record<string, unknown>) => Promise<FinetuneHandle>)
    : undefined;
}

function getPauseFn(model: AnyModel) {
  const fn = (model as Record<string, unknown>)["pause"];
  return typeof fn === "function"
    ? (fn as () => Promise<void>)
    : undefined;
}

function getCancelFn(model: AnyModel) {
  const addon = (model as Record<string, unknown>)["addon"] as
    | Record<string, unknown>
    | undefined;
  if (addon && typeof addon["cancel"] === "function") {
    return addon["cancel"] as () => Promise<void>;
  }
  return undefined;
}

export async function finetunePause(
  request: FinetuneRequest,
): Promise<FinetuneResponse> {
  if (request.op !== "pause") throw new Error("Expected op=pause");
  const model = getModel(request.modelId);
  const pauseFn = getPauseFn(model);

  if (pauseFn) {
    logger.info(`Pausing finetune for model ${request.modelId}`);
    await pauseFn.call(model);
  } else {
    const cancelFn = getCancelFn(model);
    if (cancelFn) {
      logger.info(`Pausing finetune for model ${request.modelId} (via cancel)`);
      await cancelFn();
    } else {
      throw new Error(`Model ${request.modelId} does not support pause`);
    }
  }

  return { type: "finetune", status: "PAUSED" };
}

export async function finetuneCancel(
  request: FinetuneRequest,
): Promise<FinetuneResponse> {
  if (request.op !== "cancel") throw new Error("Expected op=cancel");
  const model = getModel(request.modelId);
  const cancelFn = getCancelFn(model);

  if (!cancelFn) {
    throw new Error(`Model ${request.modelId} does not support cancel`);
  }

  logger.info(`Cancelling finetune for model ${request.modelId}`);
  await cancelFn();

  return { type: "finetune", status: "CANCELLED" };
}

export async function* finetuneStart(
  request: FinetuneStartRequest,
): AsyncGenerator<FinetuneProgress | FinetuneResponse> {
  const model = getModel(request.modelId);
  const finetuneFn = getFinetuneFn(model);

  if (!finetuneFn) {
    throw new Error(
      `Model ${request.modelId} does not support finetuning`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { type: _type, op: _op, modelId: _modelId, ...finetuneOptions } = request;

  logger.info(`Starting finetune for model ${request.modelId}`);

  const handle = await finetuneFn.call(model, finetuneOptions as Record<string, unknown>);

  let lastStats: FinetuneStats = { global_steps: 0, epochs_completed: 0 };

  const progressQueue: FinetuneProgress[] = [];
  let progressResolve: (() => void) | null = null;
  let handleDone = false;

  const onStats = (stats: FinetuneProgressStats) => {
    const progress: FinetuneProgress = {
      type: "finetuneProgress" as const,
      ...stats,
    };
    progressQueue.push(progress);

    if (stats.is_train) {
      lastStats = {
        ...lastStats,
        train_loss: stats.loss,
        train_loss_uncertainty: stats.loss_uncertainty,
        train_accuracy: stats.accuracy,
        train_accuracy_uncertainty: stats.accuracy_uncertainty,
        learning_rate: lastStats.learning_rate,
        global_steps: stats.global_steps,
        epochs_completed: stats.current_epoch,
      };
    } else {
      lastStats = {
        ...lastStats,
        val_loss: stats.loss,
        val_loss_uncertainty: stats.loss_uncertainty,
        val_accuracy: stats.accuracy,
        val_accuracy_uncertainty: stats.accuracy_uncertainty,
        global_steps: stats.global_steps,
        epochs_completed: stats.current_epoch,
      };
    }

    if (progressResolve) {
      progressResolve();
      progressResolve = null;
    }
  };

  handle.on("stats", onStats);

  const resultPromise = handle.await().then((result) => {
    handleDone = true;
    if (progressResolve) {
      progressResolve();
      progressResolve = null;
    }
    return result;
  });

  while (!handleDone) {
    if (progressQueue.length > 0) {
      yield progressQueue.shift()!;
    } else {
      await new Promise<void>((resolve) => {
        progressResolve = resolve;
      });
    }
  }

  while (progressQueue.length > 0) {
    yield progressQueue.shift()!;
  }

  handle.removeListener("stats", onStats);

  const result = await resultPromise;

  logger.info(
    `Finetune completed for model ${request.modelId} with status: ${result.status}`,
  );

  yield {
    type: "finetune" as const,
    status: result.status,
    stats: lastStats,
  };
}
