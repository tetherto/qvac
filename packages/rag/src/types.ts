import type { BaseLlmAdapter } from './adapters/llm/BaseLlmAdapter.js'

export interface Doc {
  id: string
  content: string
}

export interface EmbeddedDoc extends Doc {
  embedding: number[]
  embeddingModelId: string
  metadata?: Record<string, any> | undefined
}

export interface PartialDoc {
  content: string
  id?: string
}

export interface SaveEmbeddingsResult {
  status: 'fulfilled' | 'rejected'
  id?: string | undefined
  error?: string | undefined
}

export interface IngestResult {
  processed: SaveEmbeddingsResult[]
  droppedIndices: number[]
}

export interface SearchResult {
  id: string
  content: string
  score: number
}

export interface BaseDBAdapterConfig {
  embeddingModelId: string
  dimension: number
  createdAt: Date
}

export interface HyperDBAdapterConfig extends BaseDBAdapterConfig {
  key: string
  NUM_CENTROIDS: number
  BUCKET_SIZE: number
  BATCH_SIZE: number
}

export interface SearchParams {
  topK?: number
  n?: number
  signal?: AbortSignal
}

export interface InferOpts extends SearchParams {
  llmAdapter?: BaseLlmAdapter
  systemPrompt?: string
}

export interface BaseChunkOpts {
  [key: string]: unknown
}

export interface DbOpts {
  [key: string]: unknown
}

export interface LLMChunkOpts extends BaseChunkOpts {
  chunkSize?: number | undefined
  chunkOverlap?: number | undefined
  chunkStrategy?: 'character' | 'paragraph' | undefined
  splitStrategy?: 'character' | 'token' | 'word' | 'sentence' | 'line' | undefined
  splitter?: ((text: string) => string[]) | undefined
}

export interface EmbeddingOpts {
  onProgress?: (current: number, total: number) => void
  signal?: AbortSignal
}

export interface GenerateEmbeddingsOpts {
  chunk?: boolean
  chunkOpts?: BaseChunkOpts
  signal?: AbortSignal
}

export type SaveStage = 'deduplicating' | 'preparing' | 'writing'

export interface SaveEmbeddingsOpts {
  dbOpts?: DbOpts | undefined
  onProgress?: ((stage: SaveStage, current: number, total: number) => void) | undefined
  progressInterval?: number | undefined
  signal?: AbortSignal | undefined
}

export type IngestStage =
  'chunking' | 'embedding' | 'saving:deduplicating' | 'saving:preparing' | 'saving:writing'

export interface IngestOpts {
  chunk?: boolean | undefined
  chunkOpts?: BaseChunkOpts | undefined
  dbOpts?: DbOpts | undefined
  onProgress?: ((stage: IngestStage, current: number, total: number) => void) | undefined
  progressInterval?: number | undefined
  signal?: AbortSignal | undefined
}

export type ReindexStage = 'collecting' | 'clustering' | 'reassigning' | 'updating'

export interface ReindexOpts {
  onProgress?: ((stage: ReindexStage, current: number, total: number) => void) | undefined
  signal?: AbortSignal | undefined
}

export interface ReindexResult {
  reindexed: boolean
  details?: Record<string, any> | undefined
}

export type EmbeddingFunction = (text: string | string[]) => Promise<number[] | number[][]>

// The QVAC LLM addon returns an engine-specific response. It originates in
// @qvac/inference and is not a dependency here, so it is left opaque.
export type QvacResponse = unknown

export interface QvacLlmAddon {
  run(messages: Array<{ role: string; content: string }>, opts?: object): Promise<QvacResponse>
}
