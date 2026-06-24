import { z } from "zod";
import { whisperConfigSchema } from "./transcription-config";
import { whisperModelTypeSchema } from "./model-types";

export const modelIdSchema = z
  .string()
  .regex(/^[0-9a-f]{16}$/, "Invalid modelId format");

export const reloadConfigOptionsSchema = z.union([
  z.object({
    modelId: modelIdSchema,
    modelType: whisperModelTypeSchema,
    modelConfig: whisperConfigSchema.partial().strict(),
  }),
]);

export const reloadConfigOptionsToRequestSchema = z.union([
  z
    .object({
      modelId: modelIdSchema,
      modelType: whisperModelTypeSchema,
      modelConfig: whisperConfigSchema.partial().strict(),
    })
    .transform((data) => ({
      type: "loadModel" as const,
      modelId: data.modelId,
      modelType: data.modelType,
      modelConfig: data.modelConfig,
    })),
]);

const reloadConfigRequestBaseSchema = z.object({
  type: z.literal("loadModel"),
  modelId: modelIdSchema,
  // Explicitly exclude load-specific fields for type narrowing
  modelSrc: z.never().optional(),
  withProgress: z.never().optional(),
  delegate: z.never().optional(),
  seed: z.never().optional(),
});

export const reloadConfigWhisperRequestSchema =
  reloadConfigRequestBaseSchema.extend({
    modelType: whisperModelTypeSchema,
    modelConfig: whisperConfigSchema.partial(),
  });

// Using z.union since modelType accepts multiple values
export const reloadConfigRequestSchema = z.union([
  reloadConfigWhisperRequestSchema,
]);

export type ReloadConfigRequest = z.infer<typeof reloadConfigRequestSchema>;
export type ReloadConfigOptions = z.infer<typeof reloadConfigOptionsSchema>;
