import { z } from "zod";
import type {
  Doc,
  EmbeddedDoc,
  SaveEmbeddingsResult,
  SearchResult,
  ReindexResult,
  IngestResult,
  IngestStage,
  ReindexStage,
  SaveStage,
} from "@qvac/rag";

// ============== Common Schemas ==============

const llmChunkOptsSchema = z.object({
  chunkSize: z.number().optional(),
  chunkOverlap: z.number().optional(),
  chunkStrategy: z.enum(["character", "paragraph"]).optional(),
  splitStrategy: z
    .enum(["character", "word", "token", "sentence", "line"])
    .optional(),
});

const saveEmbeddingsResultSchema = z.object({
  status: z.enum(["fulfilled", "rejected"]),
  id: z.string().optional(),
  error: z.string().optional(),
});

// ============== Base Schemas ==============

// For storage-only operations (reindex, delete, saveEmbeddings)
// modelId is optional - only needed if no cached RAG instance exists
const ragStorageOnlyBaseSchema = z.object({
  modelId: z.string().optional(),
  workspace: z.string().optional(),
});

// For operations that need the embedding model (ingest, search)
const ragBaseSchema = ragStorageOnlyBaseSchema.extend({
  modelId: z.string(),
});

// ============== Ingest Operation ==============

export const ragIngestParamsSchema = ragBaseSchema.extend({
  documents: z.union([z.string(), z.array(z.string())]),
  chunk: z.boolean().default(true),
  chunkOpts: llmChunkOptsSchema.optional(),
  progressInterval: z.number().positive().optional(),
  onProgress: z.unknown().optional(),
  withProgress: z.boolean().optional(),
});

const ragIngestOperationSchema = ragIngestParamsSchema.extend({
  type: z.literal("rag"),
  operation: z.literal("ingest"),
});

// ============== Chunk Operation ==============

const docSchema = z.object({
  id: z.string(),
  content: z.string(),
});

export const ragChunkParamsSchema = z.object({
  documents: z.union([z.string(), z.array(z.string())]),
  chunkOpts: llmChunkOptsSchema.optional(),
});

const ragChunkOperationSchema = ragChunkParamsSchema.extend({
  type: z.literal("rag"),
  operation: z.literal("chunk"),
});

// ============== SaveEmbeddings Operation ==============

const embeddedDocSchema = z.object({
  id: z.string(),
  content: z.string(),
  embedding: z.array(z.number()),
  embeddingModelId: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ragSaveEmbeddingsParamsSchema = ragStorageOnlyBaseSchema.extend({
  documents: z.array(embeddedDocSchema),
  progressInterval: z.number().positive().optional(),
  onProgress: z.unknown().optional(),
  withProgress: z.boolean().optional(),
});

const ragSaveEmbeddingsOperationSchema = ragSaveEmbeddingsParamsSchema.extend({
  type: z.literal("rag"),
  operation: z.literal("saveEmbeddings"),
});

// ============== Reindex Operation ==============

const reindexResultSchema = z.object({
  reindexed: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const ragReindexParamsSchema = ragStorageOnlyBaseSchema.extend({
  onProgress: z.unknown().optional(),
  withProgress: z.boolean().optional(),
});

const ragReindexOperationSchema = ragReindexParamsSchema.extend({
  type: z.literal("rag"),
  operation: z.literal("reindex"),
});

// ============== Search Operation ==============

const searchResultSchema = z.object({
  id: z.string(),
  content: z.string(),
  score: z.number(),
});

export const ragSearchParamsSchema = ragBaseSchema.extend({
  query: z.string().min(1, "Query cannot be empty"),
  topK: z.number().positive().default(5),
  n: z.number().positive().default(3),
});

const ragSearchOperationSchema = ragSearchParamsSchema.extend({
  type: z.literal("rag"),
  operation: z.literal("search"),
});

// ============== Delete Embeddings Operation ==============

export const ragDeleteEmbeddingsParamsSchema = ragStorageOnlyBaseSchema.extend({
  ids: z.array(z.string()).min(1, "At least one ID must be provided"),
});

const ragDeleteEmbeddingsOperationSchema =
  ragDeleteEmbeddingsParamsSchema.extend({
    type: z.literal("rag"),
    operation: z.literal("deleteEmbeddings"),
  });

// ============== List Workspaces Operation ==============

const ragListWorkspacesOperationSchema = z.object({
  type: z.literal("rag"),
  operation: z.literal("listWorkspaces"),
});

// ============== Close Workspace Operation ==============

export const ragCloseWorkspaceParamsSchema = z.object({
  workspace: z.string().optional(),
  deleteOnClose: z.boolean().optional(),
});

const ragCloseWorkspaceOperationSchema = ragCloseWorkspaceParamsSchema.extend({
  type: z.literal("rag"),
  operation: z.literal("closeWorkspace"),
});

// ============== Delete Workspace Operation ==============

export const ragDeleteWorkspaceParamsSchema = z.object({
  workspace: z.string().min(1, "Workspace name cannot be empty"),
});

const ragDeleteWorkspaceOperationSchema = ragDeleteWorkspaceParamsSchema.extend(
  {
    type: z.literal("rag"),
    operation: z.literal("deleteWorkspace"),
  },
);

// ============== Unified Request Schema ==============

export const ragRequestSchema = z.discriminatedUnion("operation", [
  ragChunkOperationSchema,
  ragIngestOperationSchema,
  ragSaveEmbeddingsOperationSchema,
  ragSearchOperationSchema,
  ragDeleteEmbeddingsOperationSchema,
  ragReindexOperationSchema,
  ragListWorkspacesOperationSchema,
  ragCloseWorkspaceOperationSchema,
  ragDeleteWorkspaceOperationSchema,
]);

// ============== Response Schemas ==============

const ragResponseBaseSchema = z.object({
  type: z.literal("rag"),
  success: z.boolean(),
  error: z.string().optional(),
});

const ragChunkResponseSchema = ragResponseBaseSchema.extend({
  operation: z.literal("chunk"),
  chunks: z.array(docSchema),
});

const ragIngestResponseSchema = ragResponseBaseSchema.extend({
  operation: z.literal("ingest"),
  processed: z.array(saveEmbeddingsResultSchema),
  droppedIndices: z.array(z.number()),
});

const ragSaveEmbeddingsResponseSchema = ragResponseBaseSchema.extend({
  operation: z.literal("saveEmbeddings"),
  processed: z.array(saveEmbeddingsResultSchema),
});

const ragSearchResponseSchema = ragResponseBaseSchema.extend({
  operation: z.literal("search"),
  results: z.array(searchResultSchema),
});

const ragDeleteEmbeddingsResponseSchema = ragResponseBaseSchema.extend({
  operation: z.literal("deleteEmbeddings"),
});

const ragReindexResponseSchema = ragResponseBaseSchema.extend({
  operation: z.literal("reindex"),
  result: reindexResultSchema,
});

const ragWorkspaceInfoSchema = z.object({
  name: z.string(),
  open: z.boolean(),
});

const ragListWorkspacesResponseSchema = ragResponseBaseSchema.extend({
  operation: z.literal("listWorkspaces"),
  workspaces: z.array(ragWorkspaceInfoSchema),
});

const ragCloseWorkspaceResponseSchema = ragResponseBaseSchema.extend({
  operation: z.literal("closeWorkspace"),
});

const ragDeleteWorkspaceResponseSchema = ragResponseBaseSchema.extend({
  operation: z.literal("deleteWorkspace"),
});

export const ragResponseSchema = z.discriminatedUnion("operation", [
  ragChunkResponseSchema,
  ragIngestResponseSchema,
  ragSaveEmbeddingsResponseSchema,
  ragSearchResponseSchema,
  ragDeleteEmbeddingsResponseSchema,
  ragReindexResponseSchema,
  ragListWorkspacesResponseSchema,
  ragCloseWorkspaceResponseSchema,
  ragDeleteWorkspaceResponseSchema,
]);

// ============== Progress Update Schema ==============

export const ragProgressUpdateSchema = z.object({
  type: z.literal("rag:progress"),
  operation: z.enum(["ingest", "saveEmbeddings", "reindex"]),
  workspace: z.string(),
  stage: z.string(),
  current: z.number(),
  total: z.number(),
  timestamp: z.number(),
});

// ============== Type Exports ==============

// ============== Request/Response Types ==============

export type RagRequest = z.infer<typeof ragRequestSchema>;
export type RagResponse = z.infer<typeof ragResponseSchema>;
export type RagProgressUpdate = z.infer<typeof ragProgressUpdateSchema>;

// ============== Operation Params Types ==============

export type RagChunkParams = z.infer<typeof ragChunkParamsSchema>;
export type RagIngestParams = z.input<typeof ragIngestParamsSchema> & {
  onProgress?: (stage: IngestStage, current: number, total: number) => void;
};

export type RagSaveEmbeddingsParams = z.infer<
  typeof ragSaveEmbeddingsParamsSchema
> & {
  onProgress?: (stage: SaveStage, current: number, total: number) => void;
};

export type RagSearchParams = z.input<typeof ragSearchParamsSchema>;

export type RagDeleteEmbeddingsParams = z.infer<
  typeof ragDeleteEmbeddingsParamsSchema
>;

export type RagReindexParams = z.input<typeof ragReindexParamsSchema> & {
  onProgress?: (stage: ReindexStage, current: number, total: number) => void;
};

export type RagCloseWorkspaceParams = z.infer<
  typeof ragCloseWorkspaceParamsSchema
>;

export type RagDeleteWorkspaceParams = z.infer<
  typeof ragDeleteWorkspaceParamsSchema
>;

export type RagWorkspaceInfo = z.infer<typeof ragWorkspaceInfoSchema>;

// ============== Re-export types from @qvac/rag (single source of truth) ==============
export type {
  Doc as RagDoc,
  EmbeddedDoc as RagEmbeddedDoc,
  SaveEmbeddingsResult as RagSaveEmbeddingsResult,
  SearchResult as RagSearchResult,
  ReindexResult as RagReindexResult,
  IngestStage as RagIngestStage,
  ReindexStage as RagReindexStage,
  SaveStage as RagSaveStage,
  IngestResult as RagIngestResult,
};
