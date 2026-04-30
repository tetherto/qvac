// @ts-ignore brittle has no type declarations
import test from "brittle";
import {
  finetuneProgressResponseSchema,
  finetuneRequestSchema,
  finetuneResponseSchema,
  finetuneValidationSchema,
} from "@/schemas";

test("finetuneValidationSchema: defaults split validation fraction", (t) => {
  const result = finetuneValidationSchema.parse({
    type: "split",
  });

  t.is(result.type, "split");
  t.is(result.type === "split" ? result.fraction : undefined, 0.05);
});

test("finetuneRequestSchema: accepts run, state, and control operations", (t) => {
  const baseOptions = {
    trainDatasetDir: "/tmp/train.jsonl",
    validation: { type: "none" as const },
    outputParametersDir: "/tmp/out",
  };

  const autoRequest = finetuneRequestSchema.parse({
    type: "finetune",
    modelId: "model-auto",
    options: baseOptions,
    withProgress: true,
  });
  const startRequest = finetuneRequestSchema.parse({
    type: "finetune",
    modelId: "model-start",
    operation: "start",
    options: baseOptions,
    withProgress: true,
  });
  const resumeRequest = finetuneRequestSchema.parse({
    type: "finetune",
    modelId: "model-resume",
    operation: "resume",
    options: baseOptions,
  });
  const getStateRequest = finetuneRequestSchema.parse({
    type: "finetune",
    modelId: "model-state",
    operation: "getState",
    options: baseOptions,
  });
  const pauseRequest = finetuneRequestSchema.parse({
    type: "finetune",
    modelId: "model-pause",
    operation: "pause",
  });
  const cancelRequest = finetuneRequestSchema.parse({
    type: "finetune",
    modelId: "model-cancel",
    operation: "cancel",
  });

  t.is(autoRequest.operation, undefined);
  t.is(startRequest.operation, "start");
  t.is(resumeRequest.operation, "resume");
  t.is(getStateRequest.operation, "getState");
  t.is(pauseRequest.operation, "pause");
  t.is(cancelRequest.operation, "cancel");
});

test("finetuneRequestSchema: rejects dataset validation without path", (t) => {
  t.exception(() =>
    finetuneRequestSchema.parse({
      type: "finetune",
      modelId: "model-invalid",
      operation: "start",
      options: {
        trainDatasetDir: "/tmp/train.jsonl",
        validation: { type: "dataset" },
        outputParametersDir: "/tmp/out",
      },
    }),
  );
});

test("finetuneProgressResponseSchema: parses nullable progress fields", (t) => {
  const progress = finetuneProgressResponseSchema.parse({
    type: "finetune:progress",
    modelId: "model-progress",
    is_train: true,
    loss: 1.25,
    loss_uncertainty: null,
    accuracy: 0.75,
    accuracy_uncertainty: null,
    global_steps: 3,
    current_epoch: 1,
    current_batch: 2,
    total_batches: 9,
    elapsed_ms: 1500,
    eta_ms: 2500,
  });

  t.is(progress.type, "finetune:progress");
  t.is(progress.modelId, "model-progress");
  t.is(progress.loss, 1.25);
  t.is(progress.loss_uncertainty, null);
  t.is(progress.accuracy, 0.75);
  t.is(progress.global_steps, 3);
});

test("finetuneResponseSchema: parses terminal stats payload", (t) => {
  const response = finetuneResponseSchema.parse({
    type: "finetune",
    status: "COMPLETED",
    stats: {
      train_loss: 0.8,
      train_accuracy: 0.9,
      global_steps: 12,
      epochs_completed: 2,
    },
  });

  t.is(response.type, "finetune");
  t.is(response.status, "COMPLETED");
  t.is(response.stats?.global_steps, 12);
  t.is(response.stats?.epochs_completed, 2);
});

test("finetuneResponseSchema: parses idle terminal status", (t) => {
  const response = finetuneResponseSchema.parse({
    type: "finetune",
    status: "IDLE",
  });

  t.is(response.type, "finetune");
  t.is(response.status, "IDLE");
});

test("finetuneResponseSchema: parses running status", (t) => {
  const response = finetuneResponseSchema.parse({
    type: "finetune",
    status: "RUNNING",
  });

  t.is(response.type, "finetune");
  t.is(response.status, "RUNNING");
});

test("finetuneResponseSchema: parses cancelled terminal status", (t) => {
  const response = finetuneResponseSchema.parse({
    type: "finetune",
    status: "CANCELLED",
  });

  t.is(response.type, "finetune");
  t.is(response.status, "CANCELLED");
});

test("finetuneResponseSchema: accepts NaN terminal uncertainties", (t) => {
  const response = finetuneResponseSchema.parse({
    type: "finetune",
    status: "COMPLETED",
    stats: {
      train_loss: 0.8,
      train_loss_uncertainty: Number.NaN,
      val_loss: 0.7,
      val_loss_uncertainty: Number.NaN,
      train_accuracy: 0.9,
      train_accuracy_uncertainty: Number.NaN,
      val_accuracy: 0.85,
      val_accuracy_uncertainty: Number.NaN,
      global_steps: 3,
      epochs_completed: 1,
    },
  });

  t.ok(Number.isNaN(response.stats?.train_loss_uncertainty));
  t.ok(Number.isNaN(response.stats?.val_loss_uncertainty));
  t.ok(Number.isNaN(response.stats?.train_accuracy_uncertainty));
  t.ok(Number.isNaN(response.stats?.val_accuracy_uncertainty));
});

test("finetuneResponseSchema: accepts null terminal uncertainties", (t) => {
  const response = finetuneResponseSchema.parse({
    type: "finetune",
    status: "COMPLETED",
    stats: {
      train_loss: 0.8,
      train_loss_uncertainty: null,
      val_loss: 0.7,
      val_loss_uncertainty: null,
      train_accuracy: 0.9,
      train_accuracy_uncertainty: null,
      val_accuracy: 0.85,
      val_accuracy_uncertainty: null,
      global_steps: 3,
      epochs_completed: 1,
    },
  });

  t.is(response.stats?.train_loss_uncertainty, null);
  t.is(response.stats?.val_loss_uncertainty, null);
  t.is(response.stats?.train_accuracy_uncertainty, null);
  t.is(response.stats?.val_accuracy_uncertainty, null);
});
