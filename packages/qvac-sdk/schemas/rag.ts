import { z } from "zod";

// ============== Common Types ==============

const llmChunkOptsSchema = z.object({
  chunkSize: z.number().optional(),
  chunkOverlap: z.number().optional(),
  chunkStrategy: z.enum(["character", "paragraph"]).optional(),
  splitStrategy: z
    .enum(["character", "word", "token", "sentence", "line"])
    .optional(),
});

const ragSaveEmbeddingsResultSchema = z.object({
  status: z.enum(["fulfilled", "rejected"]),
  id: z.string().optional(),
  error: z.string().optional(),
});

const searchResultSchema = z.object({
  id: z.string(),
  content: z.string(),
  score: z.number(),
});

// ============== Request Schema ==============

const ragBaseSchema = z.object({
  modelId: z.string(),
  workspace: z.string().optional(), // Optional workspace for isolated storage
});

const ragSaveEmbeddingsParamsSchema = ragBaseSchema.extend({
  documents: z.union([z.string(), z.array(z.string())]),
  chunk: z.boolean().default(false),
  chunkOpts: llmChunkOptsSchema.optional(),
});

export const ragSaveEmbeddingsOperationSchema =
  ragSaveEmbeddingsParamsSchema.extend({
    type: z.literal("rag"),
    operation: z.literal("saveEmbeddings"),
  });

const ragSearchParamsSchema = ragBaseSchema.extend({
  query: z.string().min(1, "Query cannot be empty"),
  topK: z.number().positive().optional(),
  n: z.number().positive().optional(),
});

export const ragSearchOperationSchema = ragSearchParamsSchema.extend({
  type: z.literal("rag"),
  operation: z.literal("search"),
  topK: z.number().positive().default(5),
  n: z.number().positive().default(3),
});

const deleteEmbeddingsParamsSchema = ragBaseSchema.extend({
  ids: z.array(z.string()).min(1, "At least one ID must be provided"),
});

export const ragDeleteEmbeddingsOperationSchema =
  deleteEmbeddingsParamsSchema.extend({
    type: z.literal("rag"),
    operation: z.literal("deleteEmbeddings"),
  });

export const ragRequestSchema = z.discriminatedUnion("operation", [
  ragSaveEmbeddingsOperationSchema,
  ragSearchOperationSchema,
  ragDeleteEmbeddingsOperationSchema,
]);

// ============== Response Schema ==============

const ragResponseBaseSchema = z.object({
  type: z.literal("rag"),
  success: z.boolean(),
  error: z.string().optional(),
});

const ragSaveEmbeddingsResponseSchema = ragResponseBaseSchema.extend({
  operation: z.literal("saveEmbeddings"),
  processed: z.array(ragSaveEmbeddingsResultSchema),
  droppedIndices: z.array(z.number()),
});

const ragSearchResponseSchema = ragResponseBaseSchema.extend({
  operation: z.literal("search"),
  results: z.array(searchResultSchema),
});

const ragDeleteEmbeddingsResponseSchema = ragResponseBaseSchema.extend({
  operation: z.literal("deleteEmbeddings"),
});

export const ragResponseSchema = z.discriminatedUnion("operation", [
  ragSaveEmbeddingsResponseSchema,
  ragSearchResponseSchema,
  ragDeleteEmbeddingsResponseSchema,
]);

// ============== Type exports ==============

export type RagRequest = z.infer<typeof ragRequestSchema>;
export type RagResponse = z.infer<typeof ragResponseSchema>;

export type RagSaveEmbeddingsResult = z.infer<
  typeof ragSaveEmbeddingsResultSchema
>;
export type RagSearchResult = z.infer<typeof searchResultSchema>;

export type RagSaveEmbeddingsParams = z.infer<
  typeof ragSaveEmbeddingsParamsSchema
>;
export type RagDeleteEmbeddingsParams = z.infer<
  typeof deleteEmbeddingsParamsSchema
>;
export type RagSearchParams = z.infer<typeof ragSearchParamsSchema>;
