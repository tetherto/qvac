import type { Corestore } from './db/db-types.js'

export type EmbeddingMetric = 'dot' | 'cosine'

// Everything that decides whether two vectors are comparable. `spaceId` is a
// hash of this record, so dimensions alone never make two spaces match.
export interface EmbeddingSpace {
  model: string
  revision: string
  dimensions: number
  metric: EmbeddingMetric
  normalized: boolean
  documentEncoding: string
  queryEncoding: string
  preprocessing: string
}

// `embedDocuments` returns one row per text, row-major, each with the space's
// dimensions. `@qvac/rag` never applies the space's encodings; the port does.
export interface EmbeddingsPort {
  space: EmbeddingSpace
  embedDocuments(texts: string[], options?: { signal?: AbortSignal }): Promise<Float32Array>
  embedQuery(text: string, options?: { signal?: AbortSignal }): Promise<Float32Array>
}

// Passed to `rag-extract/chunk`; defaults are 256 tokens with 50 of overlap.
export interface ChunkingOptions {
  chunkSize?: number
  chunkOverlap?: number
}

export interface CreateRagOptions {
  corestore: Corestore
  // Needed for text and pre-chunked ingest and for text query search.
  embeddings?: EmbeddingsPort
  // Applies to text documents only; pre-chunked input keeps its chunks.
  chunking?: ChunkingOptions
}

export interface CreateNamespaceParams {
  name: string
  space: EmbeddingSpace
}

export interface NamespaceInfo {
  name: string
  spaceId: string
  revision: number
}

export interface EmbeddedChunkInput {
  // Defaults to `<documentId>:<ordinal>`.
  id?: string
  content: string
  metadataJson?: string
  embedding: Float32Array | ReadonlyArray<number>
  // Falls back to the document's `spaceId`.
  spaceId?: string
}

// A `rag-extract` artifact's chunks go in as-is with the `spaceId` set here.
export interface EmbeddedDocumentInput {
  id: string
  metadata?: Record<string, unknown>
  spaceId?: string
  chunks: EmbeddedChunkInput[]
}

// Chunked with `rag-extract/chunk`, then embedded through the port.
export interface TextDocument {
  id: string
  text: string
  metadata?: Record<string, unknown>
}

// A `rag-extract` chunk goes in as-is; its `tokenCount` is accepted and ignored.
export interface TextChunkInput {
  // Defaults to `<documentId>:<ordinal>`.
  id?: string
  content: string
  metadataJson?: string
  tokenCount?: number
}

// Keeps its segmentation and chunk IDs; only the embeddings come from the port.
export interface ChunkedDocument {
  id: string
  metadata?: Record<string, unknown>
  chunks: TextChunkInput[]
}

export type DocumentInput = EmbeddedDocumentInput | TextDocument | ChunkedDocument

export interface IngestParams {
  namespace: string
  documents: DocumentInput[]
}

export type IngestStage = 'chunk' | 'embed' | 'commit'

// `chunk` counts text documents, `embed` counts chunks sent to the port and
// `commit` counts documents written.
export interface IngestProgress {
  stage: IngestStage
  done: number
  total: number
}

export interface IngestOptions {
  // Checked between embedding batches and before each document's commit.
  signal?: AbortSignal
  onProgress?: (progress: IngestProgress) => void
}

export interface IngestedDocument {
  id: string
  generation: number
  chunkCount: number
}

export interface IngestResult {
  documents: IngestedDocument[]
  // Documents not committed because the signal aborted, in input order.
  skipped: string[]
  cancelled: boolean
  revision: number
}

export interface DeleteDocumentsParams {
  namespace: string
  documentIds: string[]
}

export interface DeleteDocumentsResult {
  // Only the IDs that existed; unknown IDs are ignored.
  deleted: string[]
  revision: number
}

export interface SearchScope {
  namespace: string
  documentIds?: string[]
}

export interface VectorQuery {
  vector: Float32Array | number[]
  // The `spaceId` the query was embedded in; it must match the namespace's.
  spaceId: string
  query?: never
}

// Embedded with the port's `embedQuery`, in the port's space.
export interface TextQuery {
  query: string
  vector?: never
  spaceId?: never
}

export type SearchParams = (VectorQuery | TextQuery) & {
  scope: SearchScope
  k: number
  // Checked between scan batches; an aborted search fails with OPERATION_CANCELLED.
  signal?: AbortSignal
}

export type ScopedSearchParams = (VectorQuery | TextQuery) & {
  // Intersected with the bound scope; it can narrow it, never widen it.
  scope?: Partial<SearchScope>
  k: number
  signal?: AbortSignal
}

export interface SearchHit {
  namespace: string
  documentId: string
  chunkId: string
  ordinal: number
  content: string
  metadataJson?: string
  // The document's `metadata` from ingest, when it had any.
  documentMetadata?: Record<string, unknown>
  score: number
}

export interface ScopedRag {
  search(params: ScopedSearchParams): Promise<SearchHit[]>
}

export interface Rag {
  ready(): Promise<void>
  close(): Promise<void>
  createNamespace(params: CreateNamespaceParams): Promise<NamespaceInfo>
  ingest(params: IngestParams, options?: IngestOptions): Promise<IngestResult>
  deleteDocuments(params: DeleteDocumentsParams): Promise<DeleteDocumentsResult>
  search(params: SearchParams): Promise<SearchHit[]>
  scoped(scope: SearchScope): ScopedRag
}
