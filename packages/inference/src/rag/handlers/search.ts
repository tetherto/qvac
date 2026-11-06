import { getRagInstance, hasRagWorkspaceStorage } from '@/rag/rag-workspace-manager'
import {
  createWorkspaceEmbeddingFunction,
  queryEmbeddingText,
  stashQueryEmbedding,
  takeQueryEmbedding
} from '@/rag/embedding-scope'
import { embed } from '@/plugins/ops/embed'
import { ragSearchParamsSchema, type RagSearchParams } from '@/schemas/index'

export interface SearchIdentity {
  requestId?: string | undefined
  sessionId?: string | undefined
}

/**
 * A search is not a registered RAG operation, so its query is embedded here
 * under the search's own request id and session, then handed to the
 * workspace's embedding function through the stash; see `embedding-scope`.
 */
export async function search(params: RagSearchParams, identity: SearchIdentity = {}) {
  const { modelId, query, topK, n, workspace } = ragSearchParamsSchema.parse(params)

  if (!hasRagWorkspaceStorage(workspace)) {
    return []
  }

  const rag = await getRagInstance(
    modelId,
    createWorkspaceEmbeddingFunction(modelId, workspace),
    workspace
  )
  const text = queryEmbeddingText(query)
  const { embedding } = await embed({ modelId, text }, identity.requestId, identity.sessionId)
  stashQueryEmbedding(workspace, text, embedding as number[])
  try {
    return await rag.search(query, { topK, n })
  } finally {
    takeQueryEmbedding(workspace, text)
  }
}
