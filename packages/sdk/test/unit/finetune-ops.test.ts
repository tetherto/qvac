import test from "brittle";
import {
  clearRegistry,
  registerModel,
  unregisterModel,
  type AnyModel,
} from "@/server/bare/registry/model-registry";
import { startFinetune } from "@/server/bare/plugins/llamacpp-completion/ops/finetune";
import { ModelType } from "@/schemas";
import { CompletionFailedError } from "@/utils/errors-server";

test("startFinetune: propagates busy rejection from model.finetune()", async (t) => {
  clearRegistry();
  const modelId = "finetune-busy-model";
  const busyError = new CompletionFailedError(
    `Model "${modelId}" already has an active job; pause or wait for it to finish before starting finetuning`,
  );

  registerModel(modelId, {
    model: {
      finetune: async function () {
        throw busyError;
      },
      pause: async function () {},
      cancel: async function () {},
    } as unknown as AnyModel,
    path: "/tmp/busy-model.gguf",
    config: {},
    modelType: ModelType.llamacppCompletion,
    loader: {} as never,
  });

  let caughtError: unknown;

  try {
    await startFinetune({
      type: "finetune",
      modelId,
      operation: "start",
      options: {
        trainDatasetDir: "/tmp/train.jsonl",
        validation: { type: "none" },
        outputParametersDir: "/tmp/out",
      },
    });
  } catch (error) {
    caughtError = error;
  } finally {
    unregisterModel(modelId);
    clearRegistry();
  }

  t.is(caughtError, busyError);
  t.ok(caughtError instanceof CompletionFailedError);
});

test("startFinetune: detaches progress listeners after completion", async (t) => {
  clearRegistry();
  const modelId = "finetune-listener-model";
  const seenSteps: number[] = [];
  const progress = {
    is_train: true,
    loss: 0.9,
    loss_uncertainty: null,
    accuracy: 0.8,
    accuracy_uncertainty: null,
    global_steps: 2,
    current_epoch: 0,
    current_batch: 2,
    total_batches: 4,
    elapsed_ms: 800,
    eta_ms: 1200,
  };

  type ProgressListener = (value: typeof progress) => void;
  let registeredListener: ProgressListener | null = null;
  let removeListenerCalls = 0;
  const handle = {
    on(event: "stats", cb: ProgressListener) {
      t.is(event, "stats");
      registeredListener = cb;
      return handle;
    },
    removeListener(event: "stats", cb: ProgressListener) {
      t.is(event, "stats");
      t.is(cb, registeredListener);
      removeListenerCalls++;
      return handle;
    },
    async await() {
      registeredListener?.(progress);
      return {
        op: "finetune" as const,
        status: "COMPLETED" as const,
        stats: {
          global_steps: 2,
          epochs_completed: 1,
        },
      };
    },
  };

  registerModel(modelId, {
    model: {
      finetune: async function () {
        return handle;
      },
      pause: async function () {},
      cancel: async function () {},
    } as unknown as AnyModel,
    path: "/tmp/listener-model.gguf",
    config: {},
    modelType: ModelType.llamacppCompletion,
    loader: {} as never,
  });

  try {
    const result = await startFinetune(
      {
        type: "finetune",
        modelId,
        operation: "start",
        options: {
          trainDatasetDir: "/tmp/train.jsonl",
          validation: { type: "none" },
          outputParametersDir: "/tmp/out",
        },
      },
      (update) => {
        seenSteps.push(update.global_steps);
      },
    );

    t.alike(seenSteps, [2]);
    t.is(result.status, "COMPLETED");
    t.is(removeListenerCalls, 1);
  } finally {
    unregisterModel(modelId);
    clearRegistry();
  }
});
