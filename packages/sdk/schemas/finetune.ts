import { z } from "zod";

// ============================================
// Validation
// ============================================

const finetuneValidationNoneSchema = z.object({
  type: z.literal("none"),
});

const finetuneValidationSplitSchema = z.object({
  type: z.literal("split"),
  fraction: z.number().min(0).max(1).optional(),
});

const finetuneValidationDatasetSchema = z.object({
  type: z.literal("dataset"),
  path: z.string(),
});

export const finetuneValidationSchema = z.discriminatedUnion("type", [
  finetuneValidationNoneSchema,
  finetuneValidationSplitSchema,
  finetuneValidationDatasetSchema,
]);

// ============================================
// Finetuning Options
// ============================================

export const finetuningOptionsSchema = z.object({
  trainDatasetDir: z.string(),
  validation: finetuneValidationSchema,
  outputParametersDir: z.string(),
  numberOfEpochs: z.number().int().positive().optional(),
  learningRate: z.number().positive().optional(),
  contextLength: z.number().int().positive().optional(),
  batchSize: z.number().int().positive().optional(),
  microBatchSize: z.number().int().positive().optional(),
  assistantLossOnly: z.boolean().optional(),
  loraModules: z.string().optional(),
  loraRank: z.number().int().positive().optional(),
  loraAlpha: z.number().positive().optional(),
  loraInitStd: z.number().positive().optional(),
  loraSeed: z.number().int().nonnegative().optional(),
  checkpointSaveDir: z.string().optional(),
  checkpointSaveSteps: z.number().int().nonnegative().optional(),
  chatTemplatePath: z.string().optional(),
  lrScheduler: z.enum(["constant", "cosine", "linear"]).optional(),
  lrMin: z.number().nonnegative().optional(),
  warmupRatio: z.number().min(0).max(1).optional(),
  warmupSteps: z.number().int().nonnegative().optional(),
  weightDecay: z.number().nonnegative().optional(),
});

// ============================================
// Request / Response
// ============================================

export const finetuneRequestSchema = z.object({
  type: z.literal("finetune"),
  modelId: z.string(),
}).merge(finetuningOptionsSchema);

export const finetuneStatusSchema = z.enum(["COMPLETED", "PAUSED", "CANCELLED"]);

export const finetuneStatsSchema = z.object({
  train_loss: z.number().optional(),
  train_loss_uncertainty: z.number().optional(),
  val_loss: z.number().optional(),
  val_loss_uncertainty: z.number().optional(),
  train_accuracy: z.number().optional(),
  train_accuracy_uncertainty: z.number().optional(),
  val_accuracy: z.number().optional(),
  val_accuracy_uncertainty: z.number().optional(),
  learning_rate: z.number().optional(),
  global_steps: z.number(),
  epochs_completed: z.number(),
});

export const finetuneProgressSchema = z.object({
  type: z.literal("finetuneProgress"),
  is_train: z.boolean(),
  loss: z.number(),
  loss_uncertainty: z.number().nullable(),
  accuracy: z.number(),
  accuracy_uncertainty: z.number().nullable(),
  global_steps: z.number(),
  current_epoch: z.number(),
  current_batch: z.number(),
  total_batches: z.number(),
  elapsed_ms: z.number(),
  eta_ms: z.number(),
});

export const finetuneResponseSchema = z.object({
  type: z.literal("finetune"),
  status: finetuneStatusSchema,
  stats: finetuneStatsSchema.optional(),
});

// ============================================
// Types
// ============================================

export type FinetuneValidation = z.infer<typeof finetuneValidationSchema>;
export type FinetuningOptions = z.infer<typeof finetuningOptionsSchema>;
export type FinetuneRequest = z.infer<typeof finetuneRequestSchema>;
export type FinetuneResponse = z.infer<typeof finetuneResponseSchema>;
export type FinetuneProgress = z.infer<typeof finetuneProgressSchema>;
export type FinetuneStats = z.infer<typeof finetuneStatsSchema>;
export type FinetuneStatus = z.infer<typeof finetuneStatusSchema>;
