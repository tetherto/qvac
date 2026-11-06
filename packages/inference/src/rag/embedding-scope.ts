import type { EmbeddingFunction } from '@qvac/rag'
import { embed } from '@/plugins/ops/embed'
import type { PluginHandlerContext } from '@/schemas/plugin'
import { getWorkspaceKey } from '@/rag/rag-operation-manager'

/**
 * The request a workspace's embeddings run under.
 *
 * A workspace holds one RAG instance with one embedding function for its
 * lifetime, so the function cannot be bound to the request that is using it.
 * Instead, the registered RAG operation on the workspace (`ingest`,
 * `saveEmbeddings`, `reindex`; one at a time, see `beginRagContext`) publishes
 * itself here for its duration, and the embedding function begins every
 * `embed` as a child of it: the embedding runs as the caller's session and
 * aborts with the operation. A `search` is not a registered operation and
 * runs beside them, so it embeds its query itself, under its own request, and
 * leaves the vector here for the function to hand back.
 */
const parentByWorkspace = new Map<string, PluginHandlerContext>()
const queryVectorsByWorkspace = new Map<string, Map<string, number[]>>()

export function setRagEmbedParent(
  workspace: string | undefined,
  parent: PluginHandlerContext
): void {
  parentByWorkspace.set(getWorkspaceKey(workspace), parent)
}

/** Clears the parent only while it is still the one set, so an older operation's unwind never drops a newer one. */
export function clearRagEmbedParent(
  workspace: string | undefined,
  parent: PluginHandlerContext
): void {
  const key = getWorkspaceKey(workspace)
  if (parentByWorkspace.get(key) === parent) parentByWorkspace.delete(key)
}

export function getRagEmbedParent(workspace: string | undefined): PluginHandlerContext | undefined {
  return parentByWorkspace.get(getWorkspaceKey(workspace))
}

/**
 * The text the workspace embedding function is asked for when a search runs:
 * `@qvac/rag` trims a query before it embeds it, so a search embeds and
 * stashes the trimmed text to be found by the same key.
 */
export function queryEmbeddingText(query: string): string {
  return query.trim()
}

export function stashQueryEmbedding(
  workspace: string | undefined,
  query: string,
  vector: number[]
): void {
  const key = getWorkspaceKey(workspace)
  let vectors = queryVectorsByWorkspace.get(key)
  if (!vectors) {
    vectors = new Map()
    queryVectorsByWorkspace.set(key, vectors)
  }
  vectors.set(query, vector)
}

export function takeQueryEmbedding(
  workspace: string | undefined,
  query: string
): number[] | undefined {
  const key = getWorkspaceKey(workspace)
  const vectors = queryVectorsByWorkspace.get(key)
  const vector = vectors?.get(query)
  if (vectors && vector !== undefined) {
    vectors.delete(query)
    if (vectors.size === 0) queryVectorsByWorkspace.delete(key)
  }
  return vector
}

/** The embedding function a workspace's RAG instance is created with. */
export function createWorkspaceEmbeddingFunction(
  modelId: string,
  workspace: string | undefined
): EmbeddingFunction {
  return async (text) => {
    if (typeof text === 'string') {
      const stashed = takeQueryEmbedding(workspace, text)
      if (stashed !== undefined) return stashed
    }
    const result = await embed(
      { modelId, text },
      undefined,
      undefined,
      getRagEmbedParent(workspace)
    )
    return result.embedding
  }
}
