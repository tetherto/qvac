import { z } from "zod";

const cancelBaseSchema = z.object({
  type: z.literal("cancel"),
});

export const cancelInferenceBaseSchema = z.object({
  modelId: z.string(),
});

const cancelInferenceParamsSchema = cancelInferenceBaseSchema.extend({
  operation: z.literal("inference"),
});

const cancelDownloadParamsSchema = z.object({
  operation: z.literal("downloadAsset"),
  downloadKey: z.string(),
  clearCache: z.boolean().optional(),
});

const cancelRagParamsSchema = z.object({
  operation: z.literal("rag"),
  workspace: z.string().optional(),
});

const cancelParamsSchema = z.discriminatedUnion("operation", [
  cancelInferenceParamsSchema,
  cancelDownloadParamsSchema,
  cancelRagParamsSchema,
]);

export const cancelRequestSchema = z.intersection(
  cancelBaseSchema,
  cancelParamsSchema,
);

export const cancelResponseSchema = z.object({
  type: z.literal("cancel"),
  success: z.boolean(),
  error: z.string().optional(),
});

export type CancelParams = z.infer<typeof cancelParamsSchema>;
export type CancelInferenceBaseParams = z.infer<
  typeof cancelInferenceBaseSchema
>;
export type CancelRequest = z.infer<typeof cancelRequestSchema>;
export type CancelResponse = z.infer<typeof cancelResponseSchema>;
