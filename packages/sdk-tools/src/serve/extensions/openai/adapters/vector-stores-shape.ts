import type { VectorStoreExpiresAfter, VectorStoreMeta } from '@/serve/core/stores/vector-stores'

interface OpenAIVectorStoreObject {
  id: string
  object: 'vector_store'
  created_at: number
  name: string | null
  usage_bytes: number
  file_counts: {
    in_progress: number
    completed: number
    failed: number
    cancelled: number
    total: number
  }
  status: 'completed' | 'in_progress' | 'expired'
  expires_after: VectorStoreExpiresAfter | null
  expires_at: number | null
  last_active_at: number
  metadata: Record<string, string>
}

export interface VectorStoreRagInfo {
  exists: boolean
  open?: boolean
}

export function vectorStoreToOpenAI(
  meta: VectorStoreMeta,
  ragInfo?: VectorStoreRagInfo
): OpenAIVectorStoreObject {
  const exists = ragInfo?.exists === true
  const status: 'completed' | 'in_progress' = exists ? 'completed' : 'in_progress'
  return {
    id: meta.id,
    object: 'vector_store',
    created_at: Math.floor(meta.createdAt / 1000),
    name: meta.name,
    usage_bytes: 0,
    file_counts: {
      in_progress: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      total: 0
    },
    status,
    expires_after: meta.expiresAfter,
    expires_at: meta.expiresAt === null ? null : Math.floor(meta.expiresAt / 1000),
    last_active_at: Math.floor(meta.lastActiveAt / 1000),
    metadata: { ...meta.metadata }
  }
}

interface OpenAISearchResultItem {
  file_id: string
  filename: string
  score: number
  attributes: Record<string, string>
  content: Array<{ type: 'text'; text: string }>
}

interface OpenAISearchResultsPage {
  object: 'vector_store.search_results.page'
  search_query: string
  data: OpenAISearchResultItem[]
  has_more: false
  next_page: null
}

export interface RagSearchResultLike {
  id: string
  content: string
  score: number
}

export type ChunkAttributionLookup = (
  chunkId: string
) => { fileId: string; fileName: string } | null

export function searchResultsToOpenAI(
  results: RagSearchResultLike[],
  query: string,
  lookup?: ChunkAttributionLookup
): OpenAISearchResultsPage {
  return {
    object: 'vector_store.search_results.page',
    search_query: query,
    data: results.map((r) => {
      const attribution = lookup ? lookup(r.id) : null
      return {
        file_id: attribution?.fileId ?? r.id,
        filename: attribution?.fileName ?? r.id,
        score: r.score,
        attributes: {},
        content: [{ type: 'text', text: r.content }]
      }
    }),
    has_more: false,
    next_page: null
  }
}
