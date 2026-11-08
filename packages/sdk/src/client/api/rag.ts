import { send, stream } from '@/client/rpc/rpc-client'
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
  RPCOptions
} from '@qvac/inference/surface'
import {
  InvalidResponseError,
  InvalidOperationError,
  StreamEndedError,
  RAGChunkFailedError,
  RAGSaveFailedError,
  RAGSearchFailedError,
  RAGDeleteFailedError,
  RAGCloseWorkspaceFailedError,
  RAGListWorkspacesFailedError
} from '@/utils/errors-client'
import { generateClientRequestId } from '@/client/api/client-request-id'
import { decoratePromise } from '@/utils/decorate-promise'

// ============== Chunk ==============

/**
 * Chunks documents into smaller pieces for embedding.
 * Part of the segregated flow: ragChunk() → embed() → ragSaveEmbeddings()
 *
 * @throws {RAGChunkFailedError} When the operation fails
 */
export async function ragChunk(params: RagChunkParams, options?: RPCOptions): Promise<RagDoc[]> {
  const request: RagRequest = {
    type: 'rag',
    operation: 'chunk',
    ...params
  }

  const response = await send(request, options)

  if (response.type !== 'rag') {
    throw new InvalidResponseError('rag')
  }

  if (!response.success) {
    throw new RAGChunkFailedError(response.error)
  }

  if (response.operation !== 'chunk') {
    throw new InvalidOperationError()
  }

  return response.chunks
}

// ============== Ingest ==============

/**
 * @prototype The built-in RAG vector store is not production grade. For production, use an external vector DB (see the RAG guide).
 *
 * Ingests documents into the RAG vector database.
 * Full pipeline: chunk → embed → save
 *
 * **Workspace lifecycle:** This operation implicitly opens (or creates) the workspace.
 * The workspace remains open until closed.
 *
 * @throws {RAGSaveFailedError} When the operation fails
 *
 * @throws {StreamEndedError} When streaming ends unexpectedly (only when using onProgress)
 */
export function ragIngest(
  params: RagIngestParams,
  options?: RPCOptions
): Promise<{ processed: RagSaveEmbeddingsResult[]; droppedIndices: number[] }> & {
  requestId: string
} {
  const requestId = generateClientRequestId()
  const inner = runRagIngest(params, requestId, options)
  return decoratePromise(inner, { requestId })
}

async function runRagIngest(
  params: RagIngestParams,
  requestId: string,
  options?: RPCOptions
): Promise<{ processed: RagSaveEmbeddingsResult[]; droppedIndices: number[] }> {
  const { onProgress, ...requestParams } = params

  const request: RagRequest = {
    type: 'rag',
    operation: 'ingest',
    ...requestParams,
    chunk: requestParams.chunk ?? true,
    withProgress: onProgress ? true : undefined,
    requestId
  }

  if (onProgress) {
    // Use streaming for progress updates
    for await (const event of stream(request, options)) {
      if (event.type === 'rag:progress' && event.operation === 'ingest') {
        const progress: RagProgressUpdate = event
        onProgress(progress.stage as RagIngestStage, progress.current, progress.total)
        continue
      }

      if (event.type === 'rag' && event.operation === 'ingest') {
        if (!event.success) {
          throw new RAGSaveFailedError(event.error)
        }

        return {
          processed: event.processed,
          droppedIndices: event.droppedIndices
        }
      }
    }

    throw new StreamEndedError()
  }

  const response = await send(request, options)
  if (response.type !== 'rag') {
    throw new InvalidResponseError('rag')
  }

  if (!response.success) {
    throw new RAGSaveFailedError(response.error)
  }

  if (response.operation !== 'ingest') {
    throw new InvalidOperationError()
  }

  return {
    processed: response.processed,
    droppedIndices: response.droppedIndices
  }
}

// ============== SaveEmbeddings ==============

/**
 * @prototype The built-in RAG vector store is not production grade. For production, use an external vector DB (see the RAG guide).
 *
 * Saves pre-embedded documents to the RAG vector database.
 * Part of the segregated flow: chunk() → embed() → saveEmbeddings()
 *
 * **Workspace lifecycle:** This operation implicitly opens (or creates) the workspace.
 * The workspace remains open until closed.
 *
 * @throws {RAGSaveFailedError} When the operation fails
 *
 * @throws {StreamEndedError} When streaming ends unexpectedly (only when using onProgress)
 */
export function ragSaveEmbeddings(
  params: RagSaveEmbeddingsParams,
  options?: RPCOptions
): Promise<RagSaveEmbeddingsResult[]> & { requestId: string } {
  const requestId = generateClientRequestId()
  const inner = runRagSaveEmbeddings(params, requestId, options)
  return decoratePromise(inner, { requestId })
}

async function runRagSaveEmbeddings(
  params: RagSaveEmbeddingsParams,
  requestId: string,
  options?: RPCOptions
): Promise<RagSaveEmbeddingsResult[]> {
  const { onProgress, ...requestParams } = params

  const request: RagRequest = {
    type: 'rag',
    operation: 'saveEmbeddings',
    ...requestParams,
    withProgress: onProgress ? true : undefined,
    requestId
  }

  if (onProgress) {
    for await (const event of stream(request, options)) {
      if (event.type === 'rag:progress' && event.operation === 'saveEmbeddings') {
        const progress: RagProgressUpdate = event
        onProgress(progress.stage as RagSaveStage, progress.current, progress.total)
        continue
      }

      if (event.type === 'rag' && event.operation === 'saveEmbeddings') {
        if (!event.success) {
          throw new RAGSaveFailedError(event.error)
        }

        return event.processed
      }
    }

    throw new StreamEndedError()
  }

  const response = await send(request, options)

  if (response.type !== 'rag') {
    throw new InvalidResponseError('rag')
  }

  if (!response.success) {
    throw new RAGSaveFailedError(response.error)
  }

  if (response.operation !== 'saveEmbeddings') {
    throw new InvalidOperationError()
  }

  return response.processed
}

// ============== Search ==============

/**
 * @prototype The built-in RAG vector store is not production grade. For production, use an external vector DB (see the RAG guide).
 *
 * Searches for similar documents in the RAG vector database.
 *
 * **Workspace lifecycle:** This operation requires an existing workspace. If the workspace
 * doesn't exist, returns an empty array.
 *
 * @throws {RAGSearchFailedError} When the operation fails
 */
export async function ragSearch(
  params: RagSearchParams,
  options?: RPCOptions
): Promise<RagSearchResult[]> {
  const request: RagRequest = {
    type: 'rag',
    operation: 'search',
    ...params,
    topK: params.topK ?? 5,
    n: params.n ?? 3
  }

  const response = await send(request, options)
  if (response.type !== 'rag') {
    throw new InvalidResponseError('rag')
  }

  if (!response.success) {
    throw new RAGSearchFailedError(response.error)
  }

  if (response.operation !== 'search') {
    throw new InvalidOperationError()
  }

  return response.results
}

// ============== Delete Embeddings ==============

/**
 * @prototype The built-in RAG vector store is not production grade. For production, use an external vector DB (see the RAG guide).
 *
 * Deletes document embeddings from the RAG vector database.
 *
 * **Workspace lifecycle:** This operation requires an existing workspace.
 *
 * @throws {RAGDeleteFailedError} When the operation fails or workspace doesn't exist
 */
export async function ragDeleteEmbeddings(
  params: RagDeleteEmbeddingsParams,
  options?: RPCOptions
): Promise<void> {
  const request: RagRequest = {
    type: 'rag',
    operation: 'deleteEmbeddings',
    ...params
  }

  const response = await send(request, options)
  if (response.type !== 'rag') {
    throw new InvalidResponseError('rag')
  }

  if (!response.success) {
    throw new RAGDeleteFailedError(response.error)
  }

  if (response.operation !== 'deleteEmbeddings') {
    throw new InvalidOperationError()
  }
}

// ============== Reindex ==============

/**
 * @prototype The built-in RAG vector store is not production grade. For production, use an external vector DB (see the RAG guide).
 *
 * Reindexes the RAG database to optimize search performance.
 * For HyperDB, this rebalances centroids using k-means clustering.
 *
 * **Workspace lifecycle:** This operation requires an existing workspace.
 *
 * **Note:** Reindex requires a minimum number of documents to perform clustering.
 * For HyperDB, this is 16 documents by default. If there are insufficient documents,
 * `reindexed` will be `false` with `details` explaining the reason.
 *
 * @throws {RAGSaveFailedError} When the operation fails or workspace doesn't exist
 *
 * @throws {StreamEndedError} When streaming ends unexpectedly (only when using onProgress)
 */
export function ragReindex(
  params: RagReindexParams,
  options?: RPCOptions
): Promise<RagReindexResult> & { requestId: string } {
  const requestId = generateClientRequestId()
  const inner = runRagReindex(params, requestId, options)
  return decoratePromise(inner, { requestId })
}

async function runRagReindex(
  params: RagReindexParams,
  requestId: string,
  options?: RPCOptions
): Promise<RagReindexResult> {
  const { onProgress, ...requestParams } = params

  const request: RagRequest = {
    type: 'rag',
    operation: 'reindex',
    ...requestParams,
    withProgress: onProgress ? true : undefined,
    requestId
  }

  if (onProgress) {
    for await (const event of stream(request, options)) {
      if (event.type === 'rag:progress' && event.operation === 'reindex') {
        const progress: RagProgressUpdate = event
        onProgress(progress.stage as RagReindexStage, progress.current, progress.total)
        continue
      }

      if (event.type === 'rag' && event.operation === 'reindex') {
        if (!event.success) {
          throw new RAGSaveFailedError(event.error)
        }

        return event.result
      }
    }

    throw new StreamEndedError()
  }

  const response = await send(request, options)

  if (response.type !== 'rag') {
    throw new InvalidResponseError('rag')
  }

  if (!response.success) {
    throw new RAGSaveFailedError(response.error)
  }

  if (response.operation !== 'reindex') {
    throw new InvalidOperationError()
  }

  return response.result
}

// ============== List Workspaces ==============

/**
 * @prototype The built-in RAG vector store is not production grade. For production, use an external vector DB (see the RAG guide).
 *
 * Lists all RAG workspaces with their open status.
 *
 * Returns all workspaces that exist on disk. The `open` field indicates whether
 * the workspace is currently loaded in memory and holding active resources
 * (Corestore, HyperDB adapter, and possibly a RAG instance).
 *
 * @throws {RAGListWorkspacesFailedError} When the operation fails
 */
export async function ragListWorkspaces(options?: RPCOptions): Promise<RagWorkspaceInfo[]> {
  const request: RagRequest = {
    type: 'rag',
    operation: 'listWorkspaces'
  }

  const response = await send(request, options)

  if (response.type !== 'rag') {
    throw new InvalidResponseError('rag')
  }

  if (!response.success) {
    throw new RAGListWorkspacesFailedError(response.error)
  }

  if (response.operation !== 'listWorkspaces') {
    throw new InvalidOperationError()
  }

  return response.workspaces
}

// ============== Close Workspace ==============

/**
 * @prototype The built-in RAG vector store is not production grade. For production, use an external vector DB (see the RAG guide).
 *
 * Closes a RAG workspace, releasing in-memory resources (Corestore, HyperDB adapter, RAG instance).
 *
 * **Workspace lifecycle:** Workspaces are implicitly opened.
 * This function explicitly closes them, releasing memory and file locks. The workspace data
 * remains on disk unless `deleteOnClose` is set to true.
 *
 * @throws {RAGCloseWorkspaceFailedError} When the operation fails
 */
export async function ragCloseWorkspace(
  params?: RagCloseWorkspaceParams,
  options?: RPCOptions
): Promise<void> {
  const request: RagRequest = {
    type: 'rag',
    operation: 'closeWorkspace',
    ...params
  }

  const response = await send(request, options)

  if (response.type !== 'rag') {
    throw new InvalidResponseError('rag')
  }

  if (!response.success) {
    throw new RAGCloseWorkspaceFailedError(response.error)
  }

  if (response.operation !== 'closeWorkspace') {
    throw new InvalidOperationError()
  }
}

// ============== Delete Workspace ==============

/**
 * @prototype The built-in RAG vector store is not production grade. For production, use an external vector DB (see the RAG guide).
 *
 * Deletes a RAG workspace and all its data.
 * The workspace must not be currently loaded/in-use.
 *
 * @throws {RAGDeleteFailedError} When the workspace doesn't exist or is currently loaded
 */
export async function ragDeleteWorkspace(
  params: RagDeleteWorkspaceParams,
  options?: RPCOptions
): Promise<void> {
  const request: RagRequest = {
    type: 'rag',
    operation: 'deleteWorkspace',
    ...params
  }

  const response = await send(request, options)

  if (response.type !== 'rag') {
    throw new InvalidResponseError('rag')
  }

  if (!response.success) {
    throw new RAGDeleteFailedError(response.error)
  }

  if (response.operation !== 'deleteWorkspace') {
    throw new InvalidOperationError()
  }
}
