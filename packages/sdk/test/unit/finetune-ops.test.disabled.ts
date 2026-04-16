// NOTE:
// This test file is temporarily disabled by filename so the Bun unit runner does not import it.
// Importing `@/server/bare/plugins/llamacpp-completion/ops/finetune` loads `bare-fs` at module scope,
// which currently crashes under Bun.
// This seems to be a bug in Bun itself.

import fs from "fs";
import os from "os";
import path from "path";
import test from "brittle";
import {
  clearRegistry,
  registerModel,
  unregisterModel,
  type AnyModel,
} from "@/server/bare/registry/model-registry";
import {
  finetune as finetuneOp,
  getFinetuneState,
  getFinetuneStateFromCheckpoints,
  startFinetune,
} from "@/server/bare/plugins/llamacpp-completion/ops/finetune";
import { ModelType } from "@/schemas";
import { CompletionFailedError } from "@/utils/errors-server";

function createTempCheckpointDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "finetune-op-test-"));
}

function createPauseCheckpointDir(baseDir: string, step: number) {
  const checkpointDir = path.join(
    baseDir,
    `pause_checkpoint_step_${String(step).padStart(8, "0")}`,
  );
  fs.mkdirSync(checkpointDir, { recursive: true });
  return checkpointDir;
}

function cleanupCheckpointDir(baseDir: string) {
  fs.rmSync(baseDir, { recursive: true, force: true });
}

test.skip("startFinetune: propagates busy rejection from model.finetune()", async (t) => {
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
      pause: async function () { },
      cancel: async function () { },
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

test.skip("getFinetuneStateFromCheckpoints: reports paused when any pause checkpoint exists", async (t) => {
  const checkpointDir = createTempCheckpointDir();

  try {
    createPauseCheckpointDir(checkpointDir, 7);

    const state = await getFinetuneStateFromCheckpoints({
      trainDatasetDir: "/tmp/train.jsonl",
      validation: { type: "none" },
      outputParametersDir: "/tmp/out",
      checkpointSaveDir: checkpointDir,
    });

    t.is(state, "PAUSED");
  } finally {
    cleanupCheckpointDir(checkpointDir);
  }
});

test.skip("startFinetune: rejects explicit start when a pause checkpoint exists", async (t) => {
  clearRegistry();
  const modelId = "finetune-start-paused-model";
  const checkpointDir = createTempCheckpointDir();
  let finetuneCalls = 0;

  createPauseCheckpointDir(checkpointDir, 4);

  registerModel(modelId, {
    model: {
      finetune: async function () {
        finetuneCalls++;
        throw new Error("finetune should not be called for explicit start");
      },
      pause: async function () { },
      cancel: async function () { },
    } as unknown as AnyModel,
    path: "/tmp/start-paused-model.gguf",
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
        checkpointSaveDir: checkpointDir,
      },
    });
  } catch (error) {
    caughtError = error;
  } finally {
    unregisterModel(modelId);
    clearRegistry();
    cleanupCheckpointDir(checkpointDir);
  }

  t.is(finetuneCalls, 0);
  t.ok(caughtError instanceof CompletionFailedError);
});

test.skip("startFinetune: rejects explicit resume when no pause checkpoint exists", async (t) => {
  clearRegistry();
  const modelId = "finetune-resume-idle-model";
  const checkpointDir = createTempCheckpointDir();
  let finetuneCalls = 0;

  registerModel(modelId, {
    model: {
      finetune: async function () {
        finetuneCalls++;
        throw new Error("finetune should not be called for idle resume");
      },
      pause: async function () { },
      cancel: async function () { },
    } as unknown as AnyModel,
    path: "/tmp/resume-idle-model.gguf",
    config: {},
    modelType: ModelType.llamacppCompletion,
    loader: {} as never,
  });

  let caughtError: unknown;

  try {
    await startFinetune({
      type: "finetune",
      modelId,
      operation: "resume",
      options: {
        trainDatasetDir: "/tmp/train.jsonl",
        validation: { type: "none" },
        outputParametersDir: "/tmp/out",
        checkpointSaveDir: checkpointDir,
      },
    });
  } catch (error) {
    caughtError = error;
  } finally {
    unregisterModel(modelId);
    clearRegistry();
    cleanupCheckpointDir(checkpointDir);
  }

  t.is(finetuneCalls, 0);
  t.ok(caughtError instanceof CompletionFailedError);
});

test.skip("getFinetuneState: returns idle when no pause checkpoint exists", async (t) => {
  clearRegistry();
  const modelId = "finetune-state-idle-model";
  const checkpointDir = createTempCheckpointDir();

  registerModel(modelId, {
    model: {
      finetune: async function () {
        throw new Error("finetune should not be called for getState");
      },
      pause: async function () { },
      cancel: async function () { },
    } as unknown as AnyModel,
    path: "/tmp/state-idle-model.gguf",
    config: {},
    modelType: ModelType.llamacppCompletion,
    loader: {} as never,
  });

  try {
    const result = getFinetuneState({
      type: "finetune",
      modelId,
      operation: "getState",
      options: {
        trainDatasetDir: "/tmp/train.jsonl",
        validation: { type: "none" },
        outputParametersDir: "/tmp/out",
        checkpointSaveDir: checkpointDir,
      },
    });

    t.is(result.status, "IDLE");
  } finally {
    unregisterModel(modelId);
    clearRegistry();
    cleanupCheckpointDir(checkpointDir);
  }
});

test.skip("getFinetuneState: returns running while finetune is active", async (t) => {
  clearRegistry();
  const modelId = "finetune-state-running-model";
  const checkpointDir = createTempCheckpointDir();
  let resolveAwait: ((value: {
    op: "finetune";
    status: "COMPLETED";
    stats: {
      global_steps: number;
      epochs_completed: number;
    };
  }) => void) | null = null;

  registerModel(modelId, {
    model: {
      finetune: async function () {
        return {
          on() {
            return this;
          },
          removeListener() {
            return this;
          },
          await() {
            return new Promise((resolve) => {
              resolveAwait = resolve;
            });
          },
        };
      },
      pause: async function () { },
      cancel: async function () { },
    } as unknown as AnyModel,
    path: "/tmp/state-running-model.gguf",
    config: {},
    modelType: ModelType.llamacppCompletion,
    loader: {} as never,
  });

  try {
    const startPromise = startFinetune({
      type: "finetune",
      modelId,
      options: {
        trainDatasetDir: "/tmp/train.jsonl",
        validation: { type: "none" },
        outputParametersDir: "/tmp/out",
        checkpointSaveDir: checkpointDir,
      },
    });

    const result = getFinetuneState({
      type: "finetune",
      modelId,
      operation: "getState",
      options: {
        trainDatasetDir: "/tmp/train.jsonl",
        validation: { type: "none" },
        outputParametersDir: "/tmp/out",
        checkpointSaveDir: checkpointDir,
      },
    });

    t.is(result.status, "RUNNING");

    resolveAwait?.({
      op: "finetune",
      status: "COMPLETED",
      stats: {
        global_steps: 1,
        epochs_completed: 1,
      },
    });

    await startPromise;
  } finally {
    unregisterModel(modelId);
    clearRegistry();
    cleanupCheckpointDir(checkpointDir);
  }
});

test.skip("finetune: omitted operation preserves automatic addon behavior", async (t) => {
  clearRegistry();
  const modelId = "finetune-auto-model";
  const checkpointDir = createTempCheckpointDir();
  let finetuneCalls = 0;
  let receivedCheckpointDir: string | undefined;

  createPauseCheckpointDir(checkpointDir, 9);

  registerModel(modelId, {
    model: {
      finetune: async function (options: { checkpointSaveDir?: string }) {
        finetuneCalls++;
        receivedCheckpointDir = options.checkpointSaveDir;

        return {
          on() {
            return this;
          },
          removeListener() {
            return this;
          },
          async await() {
            return {
              op: "finetune" as const,
              status: "COMPLETED" as const,
              stats: {
                global_steps: 9,
                epochs_completed: 1,
              },
            };
          },
        };
      },
      pause: async function () { },
      cancel: async function () { },
    } as unknown as AnyModel,
    path: "/tmp/auto-model.gguf",
    config: {},
    modelType: ModelType.llamacppCompletion,
    loader: {} as never,
  });

  try {
    const result = await finetuneOp({
      type: "finetune",
      modelId,
      options: {
        trainDatasetDir: "/tmp/train.jsonl",
        validation: { type: "none" },
        outputParametersDir: "/tmp/out",
        checkpointSaveDir: checkpointDir,
      },
    });

    t.is(result.status, "COMPLETED");
    t.is(finetuneCalls, 1);
    t.is(receivedCheckpointDir, checkpointDir);
  } finally {
    unregisterModel(modelId);
    clearRegistry();
    cleanupCheckpointDir(checkpointDir);
  }
});

test.skip("startFinetune: detaches progress listeners after completion", async (t) => {
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
      pause: async function () { },
      cancel: async function () { },
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
