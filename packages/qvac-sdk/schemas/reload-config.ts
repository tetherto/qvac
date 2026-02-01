import { z } from "zod";
import { whisperConfigSchema } from "./whispercpp-config";

export const modelIdSchema = z
  .string()
  .regex(/^[0-9a-f]{16}$/, "Invalid modelId format");

export const reloadConfigOptionsSchema = z.union([
  z.object({
    modelId: modelIdSchema,
    modelType: z.literal("whisper"),
    modelConfig: whisperConfigSchema.partial().strict(),
  }),
]);

export const reloadConfigOptionsToRequestSchema = z.union([
  z
    .object({
      modelId: modelIdSchema,
      modelType: z.literal("whisper"),
      modelConfig: whisperConfigSchema.partial().strict(),
    })
    .transform((data) => ({
      type: "loadModel" as const,
      modelId: data.modelId,
      modelType: "whisper" as const,
      modelConfig: data.modelConfig as z.infer<typeof whisperConfigSchema>,
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
    modelType: z.literal("whisper"),
    modelConfig: whisperConfigSchema.partial(),
  });

export const reloadConfigRequestSchema = z.discriminatedUnion("modelType", [
  reloadConfigWhisperRequestSchema,
]);

export type ReloadConfigRequest = z.infer<typeof reloadConfigRequestSchema>;
export type ReloadConfigOptions = z.infer<typeof reloadConfigOptionsSchema>;
