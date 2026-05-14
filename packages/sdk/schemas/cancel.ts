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

/**
 * Targeted cancel by `requestId` — the primary cancel path introduced in
 * SDK 0.11.0. Pair with the `requestId` field exposed on `CompletionRun`
 * (and equivalent long-running result objects) to cancel a specific
 * in-flight request rather than every request running on a given model.
 *
 * The pre-existing `{ operation: "inference", modelId }` form is kept as
 * a broad-cancel escape hatch for "cancel everything on this model"
 * scenarios (model unload, app shutdown, admin sweeps).
 */
const cancelByRequestIdParamsSchema = z.object({
  operation: z.literal("request").describe("Operation type"),
  requestId: z
    .string()
    .min(1)
    .describe(
      "Identifier of the specific in-flight request to cancel — the value exposed on the result object returned by long-running calls (e.g. `completion(...)`).",
    ),
});

const cancelParamsSchema = z.discriminatedUnion("operation", [
  cancelInferenceParamsSchema,
  cancelDownloadParamsSchema,
  cancelRagParamsSchema,
  cancelEmbeddingsParamsSchema,
  cancelByRequestIdParamsSchema,
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

/**
 * Sugar for the most common new path — `cancel({ requestId })`. The client
 * accepts either this shape (no `operation`) or the explicit
 * `{ operation: "request", requestId }` and normalises before sending.
 */
export const cancelByRequestIdSugarSchema = z
  .object({
    requestId: z.string().min(1),
  })
  .strict();

export type CancelParams = z.infer<typeof cancelParamsSchema>;
export type CancelInferenceBaseParams = z.infer<
  typeof cancelInferenceBaseSchema
>;
export type CancelByRequestIdParams = z.infer<
  typeof cancelByRequestIdParamsSchema
>;
export type CancelByRequestIdSugar = z.infer<
  typeof cancelByRequestIdSugarSchema
>;
export type CancelRequest = z.infer<typeof cancelRequestSchema>;
export type CancelResponse = z.infer<typeof cancelResponseSchema>;

/** Public client-API input — accepts the wire union *or* the requestId sugar. */
export type CancelClientInput = CancelParams | CancelByRequestIdSugar;
