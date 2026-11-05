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

export interface CreateRagOptions {
  corestore: Corestore
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
  embedding: Float32Array | number[]
  spaceId: string
}

export interface EmbeddedDocumentInput {
  id: string
  metadata?: Record<string, unknown>
  chunks: EmbeddedChunkInput[]
}

export interface IngestParams {
  namespace: string
  documents: EmbeddedDocumentInput[]
}

export interface IngestedDocument {
  id: string
  generation: number
  chunkCount: number
}

export interface IngestResult {
  documents: IngestedDocument[]
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

export interface SearchParams {
  scope: SearchScope
  vector: Float32Array | number[]
  // The `spaceId` the query was embedded in; it must match the namespace's.
  spaceId: string
  k: number
  // Checked between scan batches; an aborted search fails with OPERATION_CANCELLED.
  signal?: AbortSignal
}

export interface ScopedSearchParams {
  // Intersected with the bound scope; it can narrow it, never widen it.
  scope?: Partial<SearchScope>
  vector: Float32Array | number[]
  spaceId: string
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
  ingest(params: IngestParams): Promise<IngestResult>
  deleteDocuments(params: DeleteDocumentsParams): Promise<DeleteDocumentsResult>
  search(params: SearchParams): Promise<SearchHit[]>
  scoped(scope: SearchScope): ScopedRag
}
