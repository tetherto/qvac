import { z } from "zod";

const finetuneValidationNoneSchema = z.object({
  type: z.literal("none"),
});

const finetuneValidationSplitSchema = z.object({
  type: z.literal("split"),
  fraction: z.number().min(0).max(1).optional(),
});

const finetuneValidationDatasetSchema = z.object({
  type: z.literal("dataset"),
  path: z.string().min(1, "Validation dataset path cannot be empty"),
});

export const finetuneValidationSchema = z.discriminatedUnion("type", [
  finetuneValidationNoneSchema,
  finetuneValidationSplitSchema,
  finetuneValidationDatasetSchema,
]);

export const finetuningOptionsSchema = z.object({
  trainDatasetDir: z.string().min(1, "Training dataset path cannot be empty"),
  validation: finetuneValidationSchema,
  outputParametersDir: z
    .string()
    .min(1, "Output parameters path cannot be empty"),
  numberOfEpochs: z.number().int().positive(),
  learningRate: z.number().positive(),
  contextLength: z.number().int().positive().optional(),
  microBatchSize: z.number().int().positive().optional(),
  batchSize: z.number().int().nonnegative().optional(),
  assistantLossOnly: z.boolean().optional(),
  loraModules: z.string().optional(),
  loraRank: z.number().int().positive().optional(),
  loraAlpha: z.number().positive().optional(),
  loraDropout: z.number().min(0).max(1).optional(),
  loraInitStd: z.number().positive().optional(),
  checkpointSaveDir: z.string().min(1).optional(),
  checkpointSaveSteps: z.number().int().nonnegative().optional(),
  chatTemplatePath: z.string().optional(),
  lrScheduler: z.enum(["constant", "cosine", "linear"]).optional(),
  lrMin: z.number().nonnegative().optional(),
  warmupRatio: z.number().min(0).max(1).optional(),
  warmupRatioSet: z.boolean().optional(),
  warmupStepsSet: z.boolean().optional(),
  warmupSteps: z.number().int().nonnegative().optional(),
  weightDecay: z.number().nonnegative().optional(),
  // Compatibility with addon's optional fallback path name.
  evalDatasetDir: z.string().min(1).optional(),
  // Supported by addon and passed through as-is.
  resume: z.boolean().optional(),
});

export const finetuneParamsSchema = z.object({
  modelId: z.string(),
  finetuningOptions: finetuningOptionsSchema.optional(),
});

export const pauseFinetuneParamsSchema = z.object({
  modelId: z.string(),
});

export const resumeFinetuneParamsSchema = z.object({
  modelId: z.string(),
});

export const finetuneRequestSchema = finetuneParamsSchema.extend({
  type: z.literal("finetune"),
});

export const finetuneStatusSchema = z.enum(["COMPLETED", "PAUSED", "ERROR"]);

export const finetuneResponseSchema = z.object({
  type: z.literal("finetune"),
  status: finetuneStatusSchema,
});

export type FinetuneValidation = z.infer<typeof finetuneValidationSchema>;
export type FinetuningOptions = z.infer<typeof finetuningOptionsSchema>;
export type FinetuneParams = z.infer<typeof finetuneParamsSchema>;
export type PauseFinetuneParams = z.infer<typeof pauseFinetuneParamsSchema>;
export type ResumeFinetuneParams = z.infer<typeof resumeFinetuneParamsSchema>;
export type FinetuneRequest = z.infer<typeof finetuneRequestSchema>;
export type FinetuneStatus = z.infer<typeof finetuneStatusSchema>;
export type FinetuneResponse = z.infer<typeof finetuneResponseSchema>;
