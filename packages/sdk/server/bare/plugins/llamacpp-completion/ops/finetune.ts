import type {
  FinetuneRequest,
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

export async function* finetune(
  request: FinetuneRequest,
): AsyncGenerator<FinetuneProgress | FinetuneResponse> {
  const model = getModel(request.modelId);
  const finetuneFn = getFinetuneFn(model);

  if (!finetuneFn) {
    throw new Error(
      `Model ${request.modelId} does not support finetuning`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { type: _type, modelId: _modelId, ...finetuneOptions } = request;

  logger.info(`Starting finetune for model ${request.modelId}`);

  const handle = await finetuneFn.call(model, finetuneOptions as Record<string, unknown>);

  // Accumulate stats from progress events for the final result
  let lastStats: FinetuneStats = { global_steps: 0, epochs_completed: 0 };

  // Set up progress event forwarding via a queue
  const progressQueue: FinetuneProgress[] = [];
  let progressResolve: (() => void) | null = null;
  let handleDone = false;

  const onStats = (stats: FinetuneProgressStats) => {
    const progress: FinetuneProgress = {
      type: "finetuneProgress" as const,
      ...stats,
    };
    progressQueue.push(progress);

    // Accumulate stats for final result
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

  // Await the finetune result in the background
  const resultPromise = handle.await().then((result) => {
    handleDone = true;
    if (progressResolve) {
      progressResolve();
      progressResolve = null;
    }
    return result;
  });

  // Yield progress events as they come in
  while (!handleDone) {
    if (progressQueue.length > 0) {
      yield progressQueue.shift()!;
    } else {
      await new Promise<void>((resolve) => {
        progressResolve = resolve;
      });
    }
  }

  // Drain remaining progress events
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
