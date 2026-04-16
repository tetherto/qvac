import { send, stream } from "@/client/rpc/rpc-client";
import type {
  RagRequest,
  RagChunkParams,
  RagDoc,
  RagIngestParams,
  RagSaveEmbeddingsParams,
  RagSaveEmbeddingsResult,
  RagSearchParams,
  RagSearchResult,
  RagDeleteEmbeddingsParams,
  RagReindexParams,
  RagReindexResult,
  RagIngestStage,
  RagReindexStage,
  RagSaveStage,
  RagProgressUpdate,
  RagWorkspaceInfo,
  RagCloseWorkspaceParams,
  RagDeleteWorkspaceParams,
  RPCOptions,
} from "@/schemas";
import {
  InvalidResponseError,
  InvalidOperationError,
  StreamEndedError,
  RAGChunkFailedError,
  RAGSaveFailedError,
  RAGSearchFailedError,
  RAGDeleteFailedError,
  RAGCloseWorkspaceFailedError,
  RAGListWorkspacesFailedError,
} from "@/utils/errors-client";

// ============== Chunk ==============

/**
 * Chunks documents into smaller pieces for embedding.
 * Part of the segregated flow: ragChunk() → embed() → ragSaveEmbeddings()
 *
 * @param params - The parameters for chunking
 * @param params.documents - Documents to chunk (string or array)
 * @param params.chunkOpts - Chunking options (chunkSize, chunkOverlap, chunkStrategy)
 * @returns Array of chunk results with id and content
 * @throws {RAGChunkFailedError} When the operation fails
 *
 * @example
 * ```typescript
 * const chunks = await ragChunk({
 *   documents: ["Long document text here..."],
 *   chunkOpts: {
 *     chunkSize: 256,
 *     chunkOverlap: 50,
 *     chunkStrategy: "paragraph",
 *   },
 * });
 * ```
 */
export async function ragChunk(
  params: RagChunkParams,
  options?: RPCOptions,
): Promise<RagDoc[]> {
  const request: RagRequest = {
    type: "rag",
    operation: "chunk",
    ...params,
  };

  const response = await send(request, options);

  if (response.type !== "rag") {
    throw new InvalidResponseError("rag");
  }

  if (!response.success) {
    throw new RAGChunkFailedError(response.error);
  }

  if (response.operation !== "chunk") {
    throw new InvalidOperationError();
  }

  return response.chunks;
}

// ============== Ingest ==============

/**
 * Ingests documents into the RAG vector database.
 * Full pipeline: chunk → embed → save
 *
 * **Workspace lifecycle:** This operation implicitly opens (or creates) the workspace.
 * The workspace remains open until closed.
 *
 * @param params - The parameters for ingestion
 * @param params.modelId - The embedding model identifier
 * @param params.documents - Documents to ingest (string or array)
 * @param params.chunk - Whether to chunk documents (default: true)
 * @param params.chunkOpts - Chunking options
 * @param params.workspace - Workspace for isolated storage (default: "default"). Created if it doesn't exist.
 * @param params.onProgress - Progress callback (stage, current, total)
 * @param params.progressInterval - Minimum interval between progress updates in ms
 * @returns Processing results and dropped indices
 * @throws {RAGSaveFailedError} When the operation fails
 * @throws {StreamEndedError} When streaming ends unexpectedly (only when using onProgress)
 *
 * @example
 * ```typescript
 * // Simple ingest
 * const result = await ragIngest({
 *   modelId,
 *   documents: ["Document 1", "Document 2"],
 * });
 *
 * // With progress tracking
 * const result = await ragIngest({
 *   modelId,
 *   documents: ["Document 1", "Document 2"],
 *   workspace: "my-docs",
 *   onProgress: (stage, current, total) => {
 *     console.log(`[${stage}] ${current}/${total}`);
 *   },
 * });
 * ```
 */
export async function ragIngest(
  params: RagIngestParams,
  options?: RPCOptions,
): Promise<{ processed: RagSaveEmbeddingsResult[]; droppedIndices: number[] }> {
  const { onProgress, ...requestParams } = params;

  const request: RagRequest = {
    type: "rag",
    operation: "ingest",
    ...requestParams,
    chunk: requestParams.chunk ?? true,
    withProgress: onProgress ? true : undefined,
  };

  if (onProgress) {
    // Use streaming for progress updates
    for await (const event of stream(request, options)) {
      if (event.type === "rag:progress" && event.operation === "ingest") {
        const progress: RagProgressUpdate = event;
        onProgress(
          progress.stage as RagIngestStage,
          progress.current,
          progress.total,
        );
        continue;
      }

      if (event.type === "rag" && event.operation === "ingest") {
        if (!event.success) {
          throw new RAGSaveFailedError(event.error);
        }

        return {
          processed: event.processed,
          droppedIndices: event.droppedIndices,
        };
      }
    }

    throw new StreamEndedError();
  }

  const response = await send(request, options);
  if (response.type !== "rag") {
    throw new InvalidResponseError("rag");
  }

  if (!response.success) {
    throw new RAGSaveFailedError(response.error);
  }

  if (response.operation !== "ingest") {
    throw new InvalidOperationError();
  }

  return {
    processed: response.processed,
    droppedIndices: response.droppedIndices,
  };
}

// ============== SaveEmbeddings ==============

/**
 * Saves pre-embedded documents to the RAG vector database.
 * Part of the segregated flow: chunk() → embed() → saveEmbeddings()
 *
 * **Workspace lifecycle:** This operation implicitly opens (or creates) the workspace.
 * The workspace remains open until closed.
 *
 * @param params - The parameters for saving
 * @param params.documents - Pre-embedded documents (must have id, content, embedding, embeddingModelId)
 * @param params.workspace - Workspace for isolated storage (default: "default"). Created if it doesn't exist.
 * @param params.onProgress - Progress callback (stage, current, total)
 * @param params.progressInterval - Minimum interval between progress updates in ms
 * @returns Array of save results
 * @throws {RAGSaveFailedError} When the operation fails
 * @throws {StreamEndedError} When streaming ends unexpectedly (only when using onProgress)
 *
 * @example
 * ```typescript
 * // Segregated flow
 * const chunks = await ragChunk({ documents: ["text1", "text2"] });
 * const { embedding: embeddings } = await embed({ modelId, text: chunks.map(c => c.content) });
 * const embeddedDocs = chunks.map((chunk, i) => ({
 *   ...chunk,
 *   embedding: embeddings[i],
 *   embeddingModelId: modelId,
 * }));
 * const result = await ragSaveEmbeddings({
 *   documents: embeddedDocs,
 *   workspace: "my-workspace",
 * });
 * ```
 */
export async function ragSaveEmbeddings(
  params: RagSaveEmbeddingsParams,
  options?: RPCOptions,
): Promise<RagSaveEmbeddingsResult[]> {
  const { onProgress, ...requestParams } = params;

  const request: RagRequest = {
    type: "rag",
    operation: "saveEmbeddings",
    ...requestParams,
    withProgress: onProgress ? true : undefined,
  };

  if (onProgress) {
    for await (const event of stream(request, options)) {
      if (
        event.type === "rag:progress" &&
        event.operation === "saveEmbeddings"
      ) {
        const progress: RagProgressUpdate = event;
        onProgress(
          progress.stage as RagSaveStage,
          progress.current,
          progress.total,
        );
        continue;
      }

      if (event.type === "rag" && event.operation === "saveEmbeddings") {
        if (!event.success) {
          throw new RAGSaveFailedError(event.error);
        }

        return event.processed;
      }
    }

    throw new StreamEndedError();
  }

  const response = await send(request, options);

  if (response.type !== "rag") {
    throw new InvalidResponseError("rag");
  }

  if (!response.success) {
    throw new RAGSaveFailedError(response.error);
  }

  if (response.operation !== "saveEmbeddings") {
    throw new InvalidOperationError();
  }

  return response.processed;
}

// ============== Search ==============

/**
 * Searches for similar documents in the RAG vector database.
 *
 * **Workspace lifecycle:** This operation requires an existing workspace. If the workspace
 * doesn't exist, returns an empty array.
 *
 * @param params - The parameters for searching
 * @param params.modelId - The identifier of the embedding model to use
 * @param params.query - The search query text
 * @param params.topK - Number of top results to retrieve (default: 5)
 * @param params.n - Number of centroids to use for IVF index search (default: 3)
 * @param params.workspace - Workspace to search in (default: "default").
 * @returns Array of search results with id, content, and score. Empty array if workspace doesn't exist.
 * @throws {RAGSearchFailedError} When the operation fails
 *
 * @example
 * ```typescript
 * const results = await ragSearch({
 *   modelId,
 *   query: "AI and machine learning",
 *   topK: 5,
 *   workspace: "my-docs",
 * });
 * ```
 */
export async function ragSearch(
  params: RagSearchParams,
  options?: RPCOptions,
): Promise<RagSearchResult[]> {
  const request: RagRequest = {
    type: "rag",
    operation: "search",
    ...params,
    topK: params.topK ?? 5,
    n: params.n ?? 3,
  };

  const response = await send(request, options);
  if (response.type !== "rag") {
    throw new InvalidResponseError("rag");
  }

  if (!response.success) {
    throw new RAGSearchFailedError(response.error);
  }

  if (response.operation !== "search") {
    throw new InvalidOperationError();
  }

  return response.results;
}

// ============== Delete Embeddings ==============

/**
 * Deletes document embeddings from the RAG vector database.
 *
 * **Workspace lifecycle:** This operation requires an existing workspace.
 *
 * @param params - The parameters for deleting embeddings
 * @param params.ids - Array of document IDs to delete
 * @param params.workspace - Workspace to delete from (default: "default")
 * @throws {RAGDeleteFailedError} When the operation fails or workspace doesn't exist
 *
 * @example
 * ```typescript
 * await ragDeleteEmbeddings({
 *   ids: ["doc-1", "doc-2"],
 *   workspace: "my-docs",
 * });
 * ```
 */
export async function ragDeleteEmbeddings(
  params: RagDeleteEmbeddingsParams,
  options?: RPCOptions,
): Promise<void> {
  const request: RagRequest = {
    type: "rag",
    operation: "deleteEmbeddings",
    ...params,
  };

  const response = await send(request, options);
  if (response.type !== "rag") {
    throw new InvalidResponseError("rag");
  }

  if (!response.success) {
    throw new RAGDeleteFailedError(response.error);
  }

  if (response.operation !== "deleteEmbeddings") {
    throw new InvalidOperationError();
  }
}

// ============== Reindex ==============

/**
 * Reindexes the RAG database to optimize search performance.
 * For HyperDB, this rebalances centroids using k-means clustering.
 *
 * **Workspace lifecycle:** This operation requires an existing workspace.
 *
 * **Note:** Reindex requires a minimum number of documents to perform clustering.
 * For HyperDB, this is 16 documents by default. If there are insufficient documents,
 * `reindexed` will be `false` with `details` explaining the reason.
 *
 * @param params - The parameters for reindexing
 * @param params.workspace - Workspace to reindex (default: "default"). Must already exist.
 * @param params.onProgress - Progress callback (stage, current, total)
 * @returns Reindex result with `reindexed` boolean and optional `details`
 * @throws {RAGSaveFailedError} When the operation fails or workspace doesn't exist
 * @throws {StreamEndedError} When streaming ends unexpectedly (only when using onProgress)
 *
 * @example
 * ```typescript
 * // Simple reindex
 * const result = await ragReindex({
 *   workspace: "my-docs",
 * });
 *
 * // Check result
 * if (!result.reindexed) {
 *   console.log("Reindex skipped:", result.details?.reason);
 * }
 *
 * // With progress tracking
 * const result = await ragReindex({
 *   workspace: "my-docs",
 *   onProgress: (stage, current, total) => {
 *     console.log(`[${stage}] ${current}/${total}`);
 *   },
 * });
 * ```
 */
export async function ragReindex(
  params: RagReindexParams,
  options?: RPCOptions,
): Promise<RagReindexResult> {
  const { onProgress, ...requestParams } = params;

  const request: RagRequest = {
    type: "rag",
    operation: "reindex",
    ...requestParams,
    withProgress: onProgress ? true : undefined,
  };

  if (onProgress) {
    for await (const event of stream(request, options)) {
      if (event.type === "rag:progress" && event.operation === "reindex") {
        const progress: RagProgressUpdate = event;
        onProgress(
          progress.stage as RagReindexStage,
          progress.current,
          progress.total,
        );
        continue;
      }

      if (event.type === "rag" && event.operation === "reindex") {
        if (!event.success) {
          throw new RAGSaveFailedError(event.error);
        }

        return event.result;
      }
    }

    throw new StreamEndedError();
  }

  const response = await send(request, options);

  if (response.type !== "rag") {
    throw new InvalidResponseError("rag");
  }

  if (!response.success) {
    throw new RAGSaveFailedError(response.error);
  }

  if (response.operation !== "reindex") {
    throw new InvalidOperationError();
  }

  return response.result;
}

// ============== List Workspaces ==============

/**
 * Lists all RAG workspaces with their open status.
 *
 * Returns all workspaces that exist on disk. The `open` field indicates whether
 * the workspace is currently loaded in memory and holding active resources
 * (Corestore, HyperDB adapter, and possibly a RAG instance).
 *
 * @returns Array of workspace info with name and open status
 * @throws {RAGListWorkspacesFailedError} When the operation fails
 *
 * @example
 * ```typescript
 * const workspaces = await ragListWorkspaces();
 * // [{ name: "default", open: true }, { name: "my-docs", open: false }]
 * ```
 */
export async function ragListWorkspaces(
  options?: RPCOptions,
): Promise<RagWorkspaceInfo[]> {
  const request: RagRequest = {
    type: "rag",
    operation: "listWorkspaces",
  };

  const response = await send(request, options);

  if (response.type !== "rag") {
    throw new InvalidResponseError("rag");
  }

  if (!response.success) {
    throw new RAGListWorkspacesFailedError(response.error);
  }

  if (response.operation !== "listWorkspaces") {
    throw new InvalidOperationError();
  }

  return response.workspaces;
}

// ============== Close Workspace ==============

/**
 * Closes a RAG workspace, releasing in-memory resources (Corestore, HyperDB adapter, RAG instance).
 *
 * **Workspace lifecycle:** Workspaces are implicitly opened.
 * This function explicitly closes them, releasing memory and file locks. The workspace data
 * remains on disk unless `deleteOnClose` is set to true.
 *
 * @param params - The parameters for closing
 * @param params.workspace - Name of the workspace to close (default: "default")
 * @param params.deleteOnClose - If true, deletes the workspace data from disk after closing (default: false)
 * @throws {RAGCloseWorkspaceFailedError} When the operation fails
 *
 * @example
 * ```typescript
 * // Close a specific workspace
 * await ragCloseWorkspace({ workspace: "my-docs" });
 *
 * // Close and delete in one call
 * await ragCloseWorkspace({ workspace: "my-docs", deleteOnClose: true });
 * ```
 */
export async function ragCloseWorkspace(
  params?: RagCloseWorkspaceParams,
  options?: RPCOptions,
): Promise<void> {
  const request: RagRequest = {
    type: "rag",
    operation: "closeWorkspace",
    ...params,
  };

  const response = await send(request, options);

  if (response.type !== "rag") {
    throw new InvalidResponseError("rag");
  }

  if (!response.success) {
    throw new RAGCloseWorkspaceFailedError(response.error);
  }

  if (response.operation !== "closeWorkspace") {
    throw new InvalidOperationError();
  }
}

// ============== Delete Workspace ==============

/**
 * Deletes a RAG workspace and all its data.
 * The workspace must not be currently loaded/in-use.
 *
 * @param params - The parameters for deletion
 * @param params.workspace - Name of the workspace to delete
 * @throws {RAGDeleteFailedError} When the workspace doesn't exist or is currently loaded
 *
 * @example
 * ```typescript
 * await ragDeleteWorkspace({ workspace: "my-docs" });
 * ```
 */
export async function ragDeleteWorkspace(
  params: RagDeleteWorkspaceParams,
  options?: RPCOptions,
): Promise<void> {
  const request: RagRequest = {
    type: "rag",
    operation: "deleteWorkspace",
    ...params,
  };

  const response = await send(request, options);

  if (response.type !== "rag") {
    throw new InvalidResponseError("rag");
  }

  if (!response.success) {
    throw new RAGDeleteFailedError(response.error);
  }

  if (response.operation !== "deleteWorkspace") {
    throw new InvalidOperationError();
  }
}
