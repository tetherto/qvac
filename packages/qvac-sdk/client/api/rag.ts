import { send } from "@/client/rpc/rpc-client";
import type {
  RagRequest,
  RagSearchResult,
  RagSaveEmbeddingsParams,
  RagSearchParams,
  RagDeleteEmbeddingsParams,
  RagSaveEmbeddingsResult,
} from "@/schemas";
import {
  InvalidResponseError,
  InvalidOperationError,
  RAGSaveFailedError,
  RAGSearchFailedError,
  RAGDeleteFailedError,
} from "@/utils/errors-client";

// ============== Save Embeddings ==============

/**
 * Saves document embeddings in the RAG vector database.
 *
 * @param params - The parameters for saving embeddings
 * @param params.modelId - The identifier of the embedding model to use
 * @param params.documents - The documents to embed and save (string or array of strings)
 * @param params.chunk - Whether to chunk the documents before embedding (default: false)
 * @param params.chunkOpts - Options for chunking documents
 * @param params.workspace - Optional workspace for isolated storage
 * @throws {QvacErrorBase} When the response type is invalid or when the operation fails
 * @returns The processed results and dropped indices
 */
export async function ragSaveEmbeddings(
  params: RagSaveEmbeddingsParams,
): Promise<{ processed: RagSaveEmbeddingsResult[]; droppedIndices: number[] }> {
  const request: RagRequest = {
    type: "rag",
    operation: "saveEmbeddings",
    ...params,
  };

  const response = await send(request);
  if (response.type !== "rag") {
    throw new InvalidResponseError("rag");
  }

  if (!response.success) {
    throw new RAGSaveFailedError(response.error);
  }

  if (response.operation !== "saveEmbeddings") {
    throw new InvalidOperationError();
  }

  return {
    processed: response.processed,
    droppedIndices: response.droppedIndices,
  };
}

// ============== Search ==============

/**
 * Searches for similar documents in the RAG vector database.
 *
 * @param params - The parameters for searching
 * @param params.modelId - The identifier of the embedding model to use
 * @param params.query - The search query text
 * @param params.topK - Number of top results to retrieve (default: 5)
 * @param params.n - Number of centroids to use for IVF index search (default: 3)
 * @param params.workspace - Optional workspace for isolated storage
 * @throws {QvacErrorBase} When the response type is invalid or when the operation fails
 * @returns Array of search results with id, content, and score
 */
export async function ragSearch(
  params: RagSearchParams,
): Promise<RagSearchResult[]> {
  const request: RagRequest = {
    type: "rag",
    operation: "search",
    ...params,
    topK: params.topK ?? 5,
    n: params.n ?? 3,
  };

  const response = await send(request);
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
 * @param params - The parameters for deleting embeddings
 * @param params.modelId - The identifier of the embedding model (must match workspace model)
 * @param params.ids - Array of document IDs to delete
 * @param params.workspace - Optional workspace for isolated storage
 * @throws {QvacErrorBase} When the response type is invalid or when the operation fails
 * @returns boolean indicating success
 */
export async function ragDeleteEmbeddings(params: RagDeleteEmbeddingsParams) {
  const request: RagRequest = {
    type: "rag",
    operation: "deleteEmbeddings",
    ...params,
  };

  const response = await send(request);
  if (response.type !== "rag") {
    throw new InvalidResponseError("rag");
  }

  if (!response.success) {
    throw new RAGDeleteFailedError(response.error);
  }

  if (response.operation !== "deleteEmbeddings") {
    throw new InvalidOperationError();
  }

  return response.success;
}
