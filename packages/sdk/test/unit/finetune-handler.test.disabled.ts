// NOTE:
// This test file is temporarily disabled by filename so the Bun unit runner does not import it.
// Importing `@/server/bare/plugins/llamacpp-completion/ops/finetune` loads `bare-fs` at module scope,
// which currently crashes under Bun.
// This seems to be a bug in Bun itself.

// @ts-ignore brittle has no type declarations
import test from "brittle";
import fs from "fs";
import os from "os";
import path from "path";
import { z } from "zod";
import {
  clearRegistry,
  registerModel,
  unregisterModel,
  type AnyModel,
} from "@/server/bare/registry/model-registry";
import { clearPlugins, registerPlugin } from "@/server/plugins";
import { handleFinetune } from "@/server/rpc/handlers/finetune";
import { finetune as finetuneOp } from "@/server/bare/plugins/llamacpp-completion/ops/finetune";
import {
  ModelType,
  defineHandler,
  finetuneProgressResponseSchema,
  finetuneRequestSchema,
  finetuneResponseSchema,
  type FinetuneProgress,
  type FinetuneRequest,
  type FinetuneResult,
} from "@/schemas";

function registerFinetunePlugin() {
  registerPlugin({
    modelType: ModelType.llamacppCompletion,
    displayName: "Test Finetune Plugin",
    addonPackage: "@qvac/test-addon",
    loadConfigSchema: z.object({}),
    createModel: function () {
      return {
        model: { load: async function () { } },
        loader: {},
      };
    },
    handlers: {
      finetune: defineHandler({
        requestSchema: finetuneRequestSchema,
        responseSchema: finetuneResponseSchema,
        streaming: false,
        handler: finetuneOp,
      }),
    },
  });
}

function registerFinetuneModel(modelId: string, model: AnyModel) {
  registerModel(modelId, {
    model,
    path: "/tmp/test-model.gguf",
    config: {},
    modelType: ModelType.llamacppCompletion,
    loader: {} as never,
  });
}

function createTempCheckpointDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "finetune-handler-test-"));
}

function cleanupCheckpointDir(baseDir: string) {
  fs.rmSync(baseDir, { recursive: true, force: true });
}

test.skip("handleFinetune: wraps progress callbacks for start requests", async (t) => {
  clearRegistry();
  const modelId = "finetune-progress-model";
  const updates: Array<ReturnType<typeof finetuneProgressResponseSchema.parse>> = [];
  const progress: FinetuneProgress = {
    is_train: true,
    loss: 1.2,
    loss_uncertainty: 0.1,
    accuracy: 0.6,
    accuracy_uncertainty: 0.05,
    global_steps: 4,
    current_epoch: 1,
    current_batch: 2,
    total_batches: 8,
    elapsed_ms: 1200,
    eta_ms: 3000,
  };
  const stats = {
    train_loss: 1.2,
    train_accuracy: 0.6,
    global_steps: 4,
    epochs_completed: 1,
  };

  let registeredListener: ((value: FinetuneProgress) => void) | null = null;
  let removeListenerCalls = 0;
  const handle = {
    on(event: "stats", cb: (value: FinetuneProgress) => void) {
      t.is(event, "stats");
      registeredListener = cb;
      return handle;
    },
    removeListener(event: "stats", cb: (value: FinetuneProgress) => void) {
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
        stats,
      };
    },
  };

  registerFinetuneModel(modelId, {
    finetune: async function () {
      return handle;
    },
    pause: async function () { },
    cancel: async function () { },
  } as unknown as AnyModel);

  try {
    const request: FinetuneRequest = {
      type: "finetune",
      modelId,
      operation: "start",
      withProgress: true,
      options: {
        trainDatasetDir: "/tmp/train.jsonl",
        validation: { type: "none" },
        outputParametersDir: "/tmp/out",
      },
    };

    const result = await handleFinetune(request, (update) => {
      updates.push(finetuneProgressResponseSchema.parse(update));
    });

    t.is(updates.length, 1);
    t.is(updates[0]?.type, "finetune:progress");
    t.is(updates[0]?.modelId, modelId);
    t.is(updates[0]?.global_steps, progress.global_steps);
    t.is(result.status, "COMPLETED");
    t.is(result.stats?.global_steps, stats.global_steps);
    t.is(removeListenerCalls, 1);
  } finally {
    unregisterModel(modelId);
    clearRegistry();
  }
});

test.skip("handleFinetune: wraps progress callbacks for omitted-operation requests", async (t) => {
  clearRegistry();
  const modelId = "finetune-auto-progress-model";
  const updates: Array<ReturnType<typeof finetuneProgressResponseSchema.parse>> = [];
  const progress: FinetuneProgress = {
    is_train: true,
    loss: 0.8,
    loss_uncertainty: null,
    accuracy: 0.7,
    accuracy_uncertainty: null,
    global_steps: 2,
    current_epoch: 0,
    current_batch: 2,
    total_batches: 5,
    elapsed_ms: 500,
    eta_ms: 1500,
  };

  let registeredListener: ((value: FinetuneProgress) => void) | null = null;
  const handle = {
    on(event: "stats", cb: (value: FinetuneProgress) => void) {
      t.is(event, "stats");
      registeredListener = cb;
      return handle;
    },
    removeListener(event: "stats", cb: (value: FinetuneProgress) => void) {
      t.is(event, "stats");
      t.is(cb, registeredListener);
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

  registerFinetuneModel(modelId, {
    finetune: async function () {
      return handle;
    },
    pause: async function () { },
    cancel: async function () { },
  } as unknown as AnyModel);

  try {
    const request: FinetuneRequest = {
      type: "finetune",
      modelId,
      withProgress: true,
      options: {
        trainDatasetDir: "/tmp/train.jsonl",
        validation: { type: "none" },
        outputParametersDir: "/tmp/out",
      },
    };

    const result = await handleFinetune(request, (update) => {
      updates.push(finetuneProgressResponseSchema.parse(update));
    });

    t.is(updates.length, 1);
    t.is(updates[0]?.modelId, modelId);
    t.is(updates[0]?.global_steps, progress.global_steps);
    t.is(result.status, "COMPLETED");
  } finally {
    unregisterModel(modelId);
    clearRegistry();
  }
});

test.skip("handleFinetune: dispatches start requests without progress callbacks", async (t) => {
  clearRegistry();
  clearPlugins();
  const modelId = "finetune-dispatch-start-model";

  registerFinetunePlugin();
  registerFinetuneModel(modelId, {
    finetune: async function () {
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
              global_steps: 6,
              epochs_completed: 1,
            },
          };
        },
      };
    },
    pause: async function () { },
    cancel: async function () { },
  } as unknown as AnyModel);

  try {
    const result = await handleFinetune({
      type: "finetune",
      modelId,
      operation: "start",
      options: {
        trainDatasetDir: "/tmp/train.jsonl",
        validation: { type: "none" },
        outputParametersDir: "/tmp/out",
      },
    });

    t.is(result.type, "finetune");
    t.is(result.status, "COMPLETED");
    t.is(result.stats?.global_steps, 6);
  } finally {
    unregisterModel(modelId);
    clearPlugins();
    clearRegistry();
  }
});

test.skip("handleFinetune: dispatches getState requests through plugin reply handler", async (t) => {
  clearRegistry();
  clearPlugins();
  const modelId = "finetune-get-state-model";
  const checkpointDir = createTempCheckpointDir();

  registerFinetunePlugin();
  registerFinetuneModel(modelId, {
    finetune: async function () {
      throw new Error("finetune should not be called for getState");
    },
    pause: async function () { },
    cancel: async function () { },
  } as unknown as AnyModel);

  try {
    const result: FinetuneResult = await handleFinetune({
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

    t.is(result.type, "finetune");
    t.is(result.status, "IDLE");
  } finally {
    unregisterModel(modelId);
    clearPlugins();
    clearRegistry();
    cleanupCheckpointDir(checkpointDir);
  }
});

test.skip("handleFinetune: dispatches pause requests through plugin reply handler", async (t) => {
  clearRegistry();
  clearPlugins();
  const modelId = "finetune-dispatch-pause-model";
  let pauseCalls = 0;

  registerFinetunePlugin();
  registerFinetuneModel(modelId, {
    finetune: async function () {
      throw new Error("finetune should not be called for pause");
    },
    pause: async function () {
      pauseCalls++;
    },
    cancel: async function () { },
  } as unknown as AnyModel);

  try {
    const result: FinetuneResult = await handleFinetune({
      type: "finetune",
      modelId,
      operation: "pause",
    });

    t.is(result.type, "finetune");
    t.is(result.status, "PAUSED");
    t.is(pauseCalls, 1);
  } finally {
    unregisterModel(modelId);
    clearPlugins();
    clearRegistry();
  }
});
