import { z } from "zod";

export const unloadModelParamsSchema = z.object({
  modelId: z.string(),
  clearStorage: z.boolean().default(false),
});

export const unloadModelRequestSchema = unloadModelParamsSchema.extend({
  type: z.literal("unloadModel"),
});

export const unloadModelResponseSchema = z.object({
  type: z.literal("unloadModel"),
  success: z.boolean(),
  error: z.string().optional(),
  hasActiveModels: z.boolean().optional(),
  hasActiveProviders: z.boolean().optional(),
});

export type UnloadModelParams = z.input<typeof unloadModelParamsSchema>;
export type UnloadModelRequest = z.infer<typeof unloadModelRequestSchema>;
export type UnloadModelResponse = z.infer<typeof unloadModelResponseSchema>;
