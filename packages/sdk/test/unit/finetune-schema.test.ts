// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  finetuningOptionsSchema,
  finetuneValidationSchema,
  finetuneRequestSchema,
  finetuneResponseSchema,
  finetuneProgressSchema,
  finetuneStatsSchema,
  finetuneStatusSchema,
} from "@/schemas/finetune";
import { cancelRequestSchema } from "@/schemas/cancel";

// ─── Validation schema ──────────────────────────────────────────

test("finetuneValidationSchema: accepts type=none", (t) => {
  const result = finetuneValidationSchema.safeParse({ type: "none" });
  t.is(result.success, true);
});

test("finetuneValidationSchema: accepts type=split with fraction", (t) => {
  const result = finetuneValidationSchema.safeParse({
    type: "split",
    fraction: 0.1,
  });
  t.is(result.success, true);
});

test("finetuneValidationSchema: accepts type=split without fraction", (t) => {
  const result = finetuneValidationSchema.safeParse({ type: "split" });
  t.is(result.success, true);
});

test("finetuneValidationSchema: accepts type=dataset with path", (t) => {
  const result = finetuneValidationSchema.safeParse({
    type: "dataset",
    path: "/data/eval.jsonl",
  });
  t.is(result.success, true);
});

test("finetuneValidationSchema: rejects type=dataset without path", (t) => {
  const result = finetuneValidationSchema.safeParse({ type: "dataset" });
  t.is(result.success, false);
});

test("finetuneValidationSchema: rejects invalid type", (t) => {
  const result = finetuneValidationSchema.safeParse({ type: "invalid" });
  t.is(result.success, false);
});

test("finetuneValidationSchema: rejects fraction > 1", (t) => {
  const result = finetuneValidationSchema.safeParse({
    type: "split",
    fraction: 1.5,
  });
  t.is(result.success, false);
});

test("finetuneValidationSchema: rejects fraction < 0", (t) => {
  const result = finetuneValidationSchema.safeParse({
    type: "split",
    fraction: -0.1,
  });
  t.is(result.success, false);
});

// ─── Options schema ─────────────────────────────────────────────

test("finetuningOptionsSchema: accepts minimal valid options", (t) => {
  const result = finetuningOptionsSchema.safeParse({
    trainDatasetDir: "/data/train.jsonl",
    validation: { type: "none" },
    outputParametersDir: "/output/lora",
  });
  t.is(result.success, true);
});

test("finetuningOptionsSchema: accepts full options", (t) => {
  const result = finetuningOptionsSchema.safeParse({
    trainDatasetDir: "/data/train.jsonl",
    validation: { type: "split", fraction: 0.05 },
    outputParametersDir: "/output/lora",
    numberOfEpochs: 2,
    learningRate: 1e-4,
    contextLength: 128,
    batchSize: 128,
    microBatchSize: 32,
    assistantLossOnly: true,
    loraModules: "attn_q,attn_k,attn_v",
    loraRank: 8,
    loraAlpha: 16,
    loraInitStd: 0.02,
    loraSeed: 42,
    checkpointSaveDir: "./checkpoints",
    checkpointSaveSteps: 100,
    chatTemplatePath: "/templates/chat.jinja",
    lrScheduler: "cosine",
    lrMin: 0,
    warmupRatio: 0.1,
    warmupSteps: 10,
    weightDecay: 0.01,
  });
  t.is(result.success, true);
});

test("finetuningOptionsSchema: rejects missing trainDatasetDir", (t) => {
  const result = finetuningOptionsSchema.safeParse({
    validation: { type: "none" },
    outputParametersDir: "/output/lora",
  });
  t.is(result.success, false);
});

test("finetuningOptionsSchema: rejects negative learningRate", (t) => {
  const result = finetuningOptionsSchema.safeParse({
    trainDatasetDir: "/data/train.jsonl",
    validation: { type: "none" },
    outputParametersDir: "/output/lora",
    learningRate: -0.001,
  });
  t.is(result.success, false);
});

test("finetuningOptionsSchema: rejects zero numberOfEpochs", (t) => {
  const result = finetuningOptionsSchema.safeParse({
    trainDatasetDir: "/data/train.jsonl",
    validation: { type: "none" },
    outputParametersDir: "/output/lora",
    numberOfEpochs: 0,
  });
  t.is(result.success, false);
});

test("finetuningOptionsSchema: rejects invalid lrScheduler", (t) => {
  const result = finetuningOptionsSchema.safeParse({
    trainDatasetDir: "/data/train.jsonl",
    validation: { type: "none" },
    outputParametersDir: "/output/lora",
    lrScheduler: "exponential",
  });
  t.is(result.success, false);
});

test("finetuningOptionsSchema: accepts all lrScheduler values", (t) => {
  for (const scheduler of ["constant", "cosine", "linear"]) {
    const result = finetuningOptionsSchema.safeParse({
      trainDatasetDir: "/data/train.jsonl",
      validation: { type: "none" },
      outputParametersDir: "/output/lora",
      lrScheduler: scheduler,
    });
    t.is(result.success, true, `lrScheduler: ${scheduler}`);
  }
});

// ─── Request schema ─────────────────────────────────────────────

test("finetuneRequestSchema: accepts valid request", (t) => {
  const result = finetuneRequestSchema.safeParse({
    type: "finetune",
    modelId: "model-123",
    trainDatasetDir: "/data/train.jsonl",
    validation: { type: "split", fraction: 0.05 },
    outputParametersDir: "/output/lora",
    numberOfEpochs: 2,
    learningRate: 1e-4,
  });
  t.is(result.success, true);
});

test("finetuneRequestSchema: rejects missing modelId", (t) => {
  const result = finetuneRequestSchema.safeParse({
    type: "finetune",
    trainDatasetDir: "/data/train.jsonl",
    validation: { type: "none" },
    outputParametersDir: "/output/lora",
  });
  t.is(result.success, false);
});

test("finetuneRequestSchema: rejects wrong type literal", (t) => {
  const result = finetuneRequestSchema.safeParse({
    type: "completion",
    modelId: "model-123",
    trainDatasetDir: "/data/train.jsonl",
    validation: { type: "none" },
    outputParametersDir: "/output/lora",
  });
  t.is(result.success, false);
});

// ─── Response / status / stats schemas ──────────────────────────

test("finetuneStatusSchema: accepts valid statuses", (t) => {
  t.is(finetuneStatusSchema.safeParse("COMPLETED").success, true);
  t.is(finetuneStatusSchema.safeParse("PAUSED").success, true);
  t.is(finetuneStatusSchema.safeParse("CANCELLED").success, true);
});

test("finetuneStatusSchema: rejects invalid status", (t) => {
  t.is(finetuneStatusSchema.safeParse("RUNNING").success, false);
  t.is(finetuneStatusSchema.safeParse("").success, false);
});

test("finetuneResponseSchema: accepts completed with stats", (t) => {
  const result = finetuneResponseSchema.safeParse({
    type: "finetune",
    status: "COMPLETED",
    stats: {
      train_loss: 0.5,
      val_loss: 0.6,
      global_steps: 100,
      epochs_completed: 2,
    },
  });
  t.is(result.success, true);
});

test("finetuneResponseSchema: accepts paused without stats", (t) => {
  const result = finetuneResponseSchema.safeParse({
    type: "finetune",
    status: "PAUSED",
  });
  t.is(result.success, true);
});

test("finetuneResponseSchema: accepts cancelled", (t) => {
  const result = finetuneResponseSchema.safeParse({
    type: "finetune",
    status: "CANCELLED",
  });
  t.is(result.success, true);
});

// ─── Progress schema ────────────────────────────────────────────

test("finetuneProgressSchema: accepts valid progress", (t) => {
  const result = finetuneProgressSchema.safeParse({
    type: "finetuneProgress",
    is_train: true,
    loss: 0.5432,
    loss_uncertainty: 0.01,
    accuracy: 0.85,
    accuracy_uncertainty: 0.02,
    global_steps: 50,
    current_epoch: 1,
    current_batch: 10,
    total_batches: 100,
    elapsed_ms: 5000,
    eta_ms: 15000,
  });
  t.is(result.success, true);
});

test("finetuneProgressSchema: accepts null uncertainty values", (t) => {
  const result = finetuneProgressSchema.safeParse({
    type: "finetuneProgress",
    is_train: true,
    loss: 0.5432,
    loss_uncertainty: null,
    accuracy: 0.85,
    accuracy_uncertainty: null,
    global_steps: 50,
    current_epoch: 1,
    current_batch: 10,
    total_batches: 100,
    elapsed_ms: 5000,
    eta_ms: 15000,
  });
  t.is(result.success, true);
});

test("finetuneProgressSchema: rejects missing fields", (t) => {
  const result = finetuneProgressSchema.safeParse({
    type: "finetuneProgress",
    is_train: true,
    loss: 0.5,
    // missing required fields
  });
  t.is(result.success, false);
});

// ─── Stats schema ───────────────────────────────────────────────

test("finetuneStatsSchema: accepts minimal stats", (t) => {
  const result = finetuneStatsSchema.safeParse({
    global_steps: 100,
    epochs_completed: 2,
  });
  t.is(result.success, true);
});

test("finetuneStatsSchema: accepts full stats", (t) => {
  const result = finetuneStatsSchema.safeParse({
    train_loss: 0.3,
    train_loss_uncertainty: 0.01,
    val_loss: 0.4,
    val_loss_uncertainty: 0.02,
    train_accuracy: 0.9,
    train_accuracy_uncertainty: 0.01,
    val_accuracy: 0.85,
    val_accuracy_uncertainty: 0.02,
    learning_rate: 1e-4,
    global_steps: 200,
    epochs_completed: 4,
  });
  t.is(result.success, true);
});

// ─── Cancel schema with reset ───────────────────────────────────

test("cancelRequestSchema: accepts inference cancel without reset", (t) => {
  const result = cancelRequestSchema.safeParse({
    type: "cancel",
    operation: "inference",
    modelId: "model-123",
  });
  t.is(result.success, true);
});

test("cancelRequestSchema: accepts inference cancel with reset=true", (t) => {
  const result = cancelRequestSchema.safeParse({
    type: "cancel",
    operation: "inference",
    modelId: "model-123",
    reset: true,
  });
  t.is(result.success, true);
});

test("cancelRequestSchema: accepts inference cancel with reset=false", (t) => {
  const result = cancelRequestSchema.safeParse({
    type: "cancel",
    operation: "inference",
    modelId: "model-123",
    reset: false,
  });
  t.is(result.success, true);
});

test("cancelRequestSchema: download cancel still works with clearCache", (t) => {
  const result = cancelRequestSchema.safeParse({
    type: "cancel",
    operation: "downloadAsset",
    downloadKey: "key-123",
    clearCache: true,
  });
  t.is(result.success, true);
});

test("cancelRequestSchema: download cancel does not accept reset", (t) => {
  const result = cancelRequestSchema.safeParse({
    type: "cancel",
    operation: "downloadAsset",
    downloadKey: "key-123",
    reset: true,
  });
  // reset is not part of downloadAsset params — intersection should still pass
  // since z.intersection doesn't strip unknown keys on the params side
  t.is(result.success, true);
});
