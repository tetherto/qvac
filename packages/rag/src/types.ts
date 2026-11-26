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

// How a namespace's vector index stores vectors. `q8` works for any
// dimension; the TurboVec modes need dimensions divisible by 8 and at most 1,024.
export type IndexStorage = 'f32' | 'q8' | 'turbovec-q4' | 'turbovec-q2'

// How chunk vectors are stored in the database and in exports. 'f16' halves
// their size; scores are computed from the rounded values.
export type VectorEncoding = 'f32' | 'f16'

export interface IndexOptions {
  // Directory for index snapshots. Without it, indexes stay in memory and
  // are rebuilt from the database the first time each namespace is searched.
  dir?: string
  // Committed batches between snapshots. Defaults to 256.
  snapshotEvery?: number
  // Replaces `@qvac/turbovec-ggml`.
  provider?: IndexProvider
  // Replaces the runtime file system (`bare-fs` or Node `fs`) for snapshots.
  fs?: SnapshotFileSystem
}

// One row per query; ids past the last hit are 2^64 - 1.
export interface IndexSearchResult {
  scores: Float32Array
  ids: BigUint64Array
  k: number
}

// An index runs its calls in call order, and `length` counts finished calls only.
export interface IndexHandle {
  readonly length: number
  readonly dim: number
  // Checked against the namespace's storage when a snapshot loads.
  readonly bitWidth?: number
  addWithIds(vectors: Float32Array, ids: BigUint64Array): Promise<void>
  // Resolves whether the id was present.
  remove(id: bigint): Promise<boolean>
  contains(id: bigint): Promise<boolean>
  // Best first, by dot product.
  search(
    queries: Float32Array,
    k: number,
    options?: { signal?: AbortSignal }
  ): Promise<IndexSearchResult>
  // Without it, scoped searches over-fetch from `search` and filter.
  searchFiltered?(
    queries: Float32Array,
    k: number,
    allowedIds: BigUint64Array,
    options?: { signal?: AbortSignal }
  ): Promise<IndexSearchResult>
  // Frees removed rows. Without it, they stay until the index is rebuilt.
  compact?(): Promise<void>
  // A hint to warm up before searches.
  prepare?(): Promise<void>
  // With the provider's `load`, enables snapshots.
  write?(path: string): Promise<void>
  dispose(): Promise<void>
}

export interface IndexProvider {
  create(dim: number, storage: IndexStorage): IndexHandle | Promise<IndexHandle>
  load?(path: string): Promise<IndexHandle>
}

// The subset of `fs.promises` snapshots use.
export interface SnapshotFileSystem {
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, data: string): Promise<unknown>
  rename(from: string, to: string): Promise<unknown>
  unlink(path: string): Promise<unknown>
  // Without it, files the sidecar doesn't name are left behind.
  readdir?(path: string): Promise<string[]>
}

export interface CreateRagOptions {
  corestore: Corestore
  // Needed for text and pre-chunked ingest and for text query search.
  embeddings?: EmbeddingsPort
  // Applies to text documents only; pre-chunked input keeps its chunks.
  chunking?: ChunkingOptions
  // Used only when `@qvac/turbovec-ggml` is installed; without it search
  // scans the database.
  index?: IndexOptions
  // Called once per namespace each time its searches switch to the scan.
  // A throw or a rejected promise from it is ignored.
  onIndexFallback?: (event: IndexFallbackEvent) => void
  // Called when a namespace's snapshot can't be read or written.
  onSnapshotError?: (event: SnapshotErrorEvent) => void
}

// Why a namespace is searched by scan instead of its index.
export type IndexFallbackReason =
  'addon-missing' | 'addon-load-failed' | 'rebuild-failed' | 'search-failed'

export interface IndexFallbackEvent {
  namespace: string
  reason: IndexFallbackReason
  error?: unknown
}

// The index stays in memory and in index mode; only reopening is slower.
export interface SnapshotErrorEvent {
  namespace: string
  error: unknown
}

export interface IndexStatusParams {
  namespace: string
}

export type IndexStatus =
  | { mode: 'index'; revision: number; snapshot: 'off' | 'none' | 'ok' | { error: unknown } }
  | { mode: 'scan'; reason: IndexFallbackReason; error?: unknown }
  | { mode: 'unopened' }

export interface CreateNamespaceParams {
  name: string
  space: EmbeddingSpace
  // Fixed at creation. Defaults to `{ storage: 'q8' }`.
  index?: { storage?: IndexStorage }
  // Fixed at creation. Defaults to 'f32'.
  vectorEncoding?: VectorEncoding
}

export interface NamespaceInfo {
  name: string
  spaceId: string
  revision: number
  index: { storage: IndexStorage }
  vectorEncoding: VectorEncoding
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
// `commit` counts documents written or found unchanged.
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

// `unchanged`: the stored generation already has the same content, so nothing
// was written. Content covers the chunks after chunking, their vectors when
// precomputed, and the document metadata.
export type IngestedDocument = {
  id: string
  generation: number
  chunkCount: number
} & (
  | { status: 'created' | 'unchanged' }
  // `removedChunks` counts the previous generation's chunks.
  | { status: 'replaced'; removedChunks: number }
)

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

// `k` is the number of hits to return. With `perDocument`, every document's best
// hit is seated before any document gets a second one, and no document gets
// more than `perDocument`. When `scope.documentIds` lists at most `k` documents,
// each one that has chunks gets a hit. Hits scoring below `minScore` are
// dropped first, so a result can hold fewer than `k`.
export type SearchParams = (VectorQuery | TextQuery) & {
  scope: SearchScope
  k: number
  perDocument?: number
  minScore?: number
  // Checked between scan batches; an aborted search fails with OPERATION_CANCELLED.
  signal?: AbortSignal
}

export type ScopedSearchParams = (VectorQuery | TextQuery) & {
  // Intersected with the bound scope; it can narrow it, never widen it.
  scope?: Partial<SearchScope>
  k: number
  perDocument?: number
  minScore?: number
  signal?: AbortSignal
}

// Lifted from the document's `metadata`, else from the chunk's `metadataJson`
// (the rag-extract chunk format). `page` only comes from the chunk. A key is
// absent unless it holds a non-empty string, or for `page` an integer >= 1.
export interface SearchCitation {
  title?: string
  page?: number
  sourceUrl?: string
  sourcePath?: string
  mimeType?: string
}

export interface SearchHit {
  namespace: string
  documentId: string
  chunkId: string
  ordinal: number
  // The document's generation the chunk belongs to; re-ingest bumps it.
  generation: number
  // Chunks in that generation.
  chunkCount: number
  content: string
  metadataJson?: string
  // The document's `metadata` from ingest, when it had any.
  documentMetadata?: Record<string, unknown>
  citation: SearchCitation
  score: number
}

// `fromOrdinal` defaults to 0 and `limit` to 64 chunks, at most 1,024. Pass the
// first page's `generation` on later pages: a document re-ingested or deleted
// since then fails with DOCUMENT_CHANGED instead of mixing generations.
export interface ReadDocumentParams {
  namespace: string
  documentId: string
  generation?: number
  fromOrdinal?: number
  limit?: number
}

export type ScopedReadDocumentParams = Omit<ReadDocumentParams, 'namespace'>

export interface DocumentChunk {
  chunkId: string
  ordinal: number
  content: string
  metadataJson?: string
}

export interface DocumentPage {
  namespace: string
  documentId: string
  generation: number
  chunkCount: number
  metadata?: Record<string, unknown>
  chunks: DocumentChunk[]
  // The `fromOrdinal` of the next page; null after the last chunk.
  nextOrdinal: number | null
}

// Documents come in document ID order. `after` is the previous page's `next`;
// `limit` defaults to 100, at most 1,024.
export interface ListDocumentsParams {
  namespace: string
  after?: string
  limit?: number
}

export type ScopedListDocumentsParams = Omit<ListDocumentsParams, 'namespace'>

export interface DocumentSummary {
  documentId: string
  generation: number
  chunkCount: number
  // The namespace revision that committed this generation, so sorting by it
  // gives ingest order. 0 for documents written before revisions were recorded.
  revision: number
  metadata?: Record<string, unknown>
}

export interface DocumentListPage {
  documents: DocumentSummary[]
  next: string | null
}

// Without `documentIds`, the whole namespace. With them, only those documents
// and their delete records; an ID the namespace doesn't have is left out.
export interface ExportNamespaceParams {
  namespace: string
  documentIds?: string[]
}

export interface ExportOptions {
  // Checked before each frame; an aborted export fails with OPERATION_CANCELLED.
  signal?: AbortSignal
}

export interface ImportNamespaceParams {
  namespace: string
  // The bytes of an `exportNamespace` stream, in any chunking.
  source: AsyncIterable<Uint8Array>
  // Used only when the import creates the namespace. Defaults to `{ storage: 'q8' }`.
  index?: { storage?: IndexStorage }
}

// Counts the documents and delete records read so far.
export interface ImportProgress {
  documents: number
  deletes: number
}

export interface ImportOptions {
  // Checked before each document commits; also ends a wait on the source.
  signal?: AbortSignal
  onProgress?: (progress: ImportProgress) => void
}

// `deleted`: a delete record in the stream removed the target's document.
export interface ImportedDocument {
  id: string
  generation: number
  status: 'created' | 'replaced' | 'unchanged' | 'deleted'
}

// `superseded`: the target holds a newer generation. `deleted`: the target
// deleted that generation or a later one. `conflict`: the target holds the
// same generation with other content.
export interface ImportSkip {
  id: string
  generation: number
  reason: 'superseded' | 'deleted' | 'conflict'
}

export interface ImportResult {
  documents: ImportedDocument[]
  skipped: ImportSkip[]
  cancelled: boolean
  revision: number
}

export interface NamespaceSummary {
  name: string
  spaceId: string
  space: EmbeddingSpace
  index: { storage: IndexStorage }
  vectorEncoding: VectorEncoding
  revision: number
  documentCount: number
  chunkCount: number
}

export interface DropNamespaceParams {
  name: string
}

export interface DropNamespaceResult {
  name: string
  documentCount: number
  chunkCount: number
}

export interface ScopedRag {
  search(params: ScopedSearchParams): Promise<SearchHit[]>
  readDocument(params: ScopedReadDocumentParams): Promise<DocumentPage>
  listDocuments(params?: ScopedListDocumentsParams): Promise<DocumentListPage>
}

export interface Rag {
  ready(): Promise<void>
  close(): Promise<void>
  createNamespace(params: CreateNamespaceParams): Promise<NamespaceInfo>
  ingest(params: IngestParams, options?: IngestOptions): Promise<IngestResult>
  deleteDocuments(params: DeleteDocumentsParams): Promise<DeleteDocumentsResult>
  search(params: SearchParams): Promise<SearchHit[]>
  readDocument(params: ReadDocumentParams): Promise<DocumentPage>
  listDocuments(params: ListDocumentsParams): Promise<DocumentListPage>
  exportNamespace(params: ExportNamespaceParams, options?: ExportOptions): AsyncIterable<Uint8Array>
  importNamespace(params: ImportNamespaceParams, options?: ImportOptions): Promise<ImportResult>
  listNamespaces(): Promise<NamespaceSummary[]>
  dropNamespace(params: DropNamespaceParams): Promise<DropNamespaceResult>
  indexStatus(params: IndexStatusParams): Promise<IndexStatus>
  scoped(scope: SearchScope): ScopedRag
}
