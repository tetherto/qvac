import { getRagInstance } from '@/rag/rag-workspace-manager'
import { createWorkspaceEmbeddingFunction } from '@/rag/embedding-scope'
import { ragIngestParamsSchema, type RagIngestParams } from '@/schemas/index'
import type { AbortSignal } from 'bare-abort-controller'
import type { IngestOpts, IngestStage } from '@qvac/rag'

interface IngestHandlerOptions {
  onProgress?: (stage: IngestStage, current: number, total: number) => void
  signal?: AbortSignal
}

export async function ingest(params: RagIngestParams, options?: IngestHandlerOptions) {
  const { modelId, documents, chunk, chunkOpts, workspace, progressInterval } =
    ragIngestParamsSchema.parse(params)

  const rag = await getRagInstance(
    modelId,
    createWorkspaceEmbeddingFunction(modelId, workspace),
    workspace
  )

  const ingestOpts: IngestOpts = {
    chunk,
    chunkOpts,
    progressInterval,
    onProgress: options?.onProgress,
    signal: options?.signal
  }

  return await rag.ingest(documents, modelId, ingestOpts)
}
