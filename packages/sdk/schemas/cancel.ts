import { z } from "zod";
import { delegateBaseSchema } from "./delegate";

const cancelBaseSchema = z.object({
  type: z.literal("cancel"),
});

export const cancelInferenceBaseSchema = z.object({
  modelId: z.string().describe("The model ID to cancel inference for"),
});

const cancelInferenceParamsSchema = cancelInferenceBaseSchema.extend({
  operation: z.literal("inference").describe("Operation type"),
});

const cancelDownloadParamsSchema = z.object({
  operation: z.literal("downloadAsset").describe("Operation type"),
  downloadKey: z.string().describe("The download key to cancel"),
  clearCache: z
    .boolean()
    .optional()
    .describe("If true, deletes the partial download file"),
  delegate: delegateBaseSchema.optional(),
});

const cancelRagParamsSchema = z.object({
  operation: z.literal("rag").describe("Operation type"),
  workspace: z.string().optional().describe("The RAG workspace to cancel"),
});

const cancelEmbeddingsParamsSchema = cancelInferenceBaseSchema.extend({
  operation: z.literal("embeddings").describe("Operation type"),
});

const cancelParamsSchema = z.discriminatedUnion("operation", [
  cancelInferenceParamsSchema,
  cancelDownloadParamsSchema,
  cancelRagParamsSchema,
  cancelEmbeddingsParamsSchema,
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
