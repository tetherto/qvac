import { QvacErrorRAG, ERR_CODES } from './errors.js'
import { decodeVectorInto } from './db/encoding.js'
import {
  CHUNKS,
  DOCUMENTS,
  type ChunkRecord,
  type DocumentRecord,
  type SpaceRecord
} from './db/records.js'
import type { HyperDBReader } from './db/db-types.js'
import { selectDiverse } from './diversify.js'
import type { SearchCitation, SearchHit, SearchScope } from './types.js'

// Rows decoded and scored per step. Memory stays bounded by this and by k (with
// `perDocument`, k documents of at most `perDocument` hits each).
export const SCAN_BATCH_SIZE = 256

export interface SearchQuery {
  vector: Float32Array
  spaceId: string
}

export interface SearchOptions {
  strict: boolean
  signal?: AbortSignal
  // Caps hits per document and seats every document's best hit first.
  perDocument?: number
  // Hits scoring below it are dropped before `perDocument` and `k` apply.
  minScore?: number
}

interface Ranked {
  score: number
  hit: SearchHit
}

// Exact scan over the chunks inside `scope`. Out-of-scope rows are never read,
// so only allowed chunks compete for the top k. With `perDocument`, each
// document keeps its own top `perDocument`, and only the k documents with the
// best first hits are held: when k documents exist the selection seats exactly
// their best hits, and when fewer exist every one is held. Chunks arrive grouped
// by document, so a document is complete when the next one starts.
export async function scanSearch(
  reader: HyperDBReader,
  space: SpaceRecord,
  scope: SearchScope,
  { vector: query, spaceId }: SearchQuery,
  k: number,
  options: SearchOptions
): Promise<SearchHit[]> {
  throwIfAborted(options.signal)
  checkQuery(space, scope, { vector: query, spaceId })
  if (scope.documentIds !== undefined && scope.documentIds.length === 0) return []

  const ranges = await resolveRanges(reader, scope, options.strict)
  const cosine = space.metric === 'cosine'
  const queryNorm = cosine ? norm(query, 0, query.length) : 1
  const dims = space.dimensions
  const vectors = new Float32Array(SCAN_BATCH_SIZE * dims)
  const batch: ChunkRecord[] = []
  const top: Ranked[] = []
  const { perDocument, minScore } = options
  const rank = documentRank(scope)
  const held: Ranked[][] = []
  let current: Ranked[] = []
  let currentId: string | null = null

  // Keeps `held` to the k documents whose best hits rank first, best first.
  function settle() {
    const kept = current
    current = []
    if (kept.length === 0) return
    const best = kept[0].hit
    if (held.length === k && compareHits(best, held[k - 1][0].hit, rank) >= 0) return
    let at = held.length
    while (at > 0 && compareHits(best, held[at - 1][0].hit, rank) < 0) at--
    held.splice(at, 0, kept)
    if (held.length > k) held.pop()
  }

  function keep(score: number, chunk: ChunkRecord) {
    if (perDocument !== undefined && chunk.documentId !== currentId) {
      settle()
      currentId = chunk.documentId
    }
    if (minScore !== undefined && score < minScore) return
    if (perDocument === undefined) return offer(top, k, score, chunk)
    offer(current, Math.min(k, perDocument), score, chunk)
  }

  function scoreBatch() {
    for (let row = 0; row < batch.length; row++) {
      const offset = row * dims
      let score = dot(query, vectors, offset)
      if (cosine) {
        const denominator = queryNorm * norm(vectors, offset, dims)
        score = denominator === 0 ? 0 : score / denominator
      }
      keep(score, batch[row])
    }
    batch.length = 0
  }

  for (const range of ranges) {
    for await (const chunk of reader.find<ChunkRecord>(CHUNKS, range)) {
      checkStoredVector(chunk, dims)
      decodeVectorInto(chunk.vector, vectors, batch.length * dims, dims)
      batch.push(chunk)
      if (batch.length === SCAN_BATCH_SIZE) {
        scoreBatch()
        await yieldForAbort(options.signal)
      }
    }
  }
  scoreBatch()
  settle()
  throwIfAborted(options.signal)

  let hits = top.map((entry) => entry.hit)
  if (perDocument !== undefined) {
    const ranked: SearchHit[] = []
    for (const kept of held) for (const entry of kept) ranked.push(entry.hit)
    hits = selectDiverse(sortHits(ranked, scope), k, perDocument)
  }
  await attachDocumentDetails(reader, scope.namespace, hits)
  return hits
}

// Score first; ties go by the scope's document order for a document list and by
// key order (document ID, then ordinal) otherwise, which is the scan's order.
export function sortHits(hits: SearchHit[], scope: SearchScope): SearchHit[] {
  const rank = documentRank(scope)
  return hits.sort((a, b) => compareHits(a, b, rank))
}

function documentRank(scope: SearchScope): Map<string, number> {
  return new Map(scope.documentIds?.map((documentId, i) => [documentId, i]))
}

function compareHits(a: SearchHit, b: SearchHit, rank: Map<string, number>): number {
  if (a.score !== b.score) return b.score - a.score
  if (a.documentId !== b.documentId) {
    const ra = rank.get(a.documentId)
    const rb = rank.get(b.documentId)
    if (ra !== undefined && rb !== undefined) return ra - rb
    return a.documentId < b.documentId ? -1 : 1
  }
  return a.ordinal - b.ordinal
}

export function checkQuery(
  space: SpaceRecord,
  scope: SearchScope,
  { vector: query, spaceId }: SearchQuery
): void {
  // Matching dimensions do not make two embedding spaces comparable.
  if (spaceId !== space.spaceId) {
    throw new QvacErrorRAG({
      code: ERR_CODES.EMBEDDING_SPACE_MISMATCH,
      adds: `query is in space ${spaceId}, namespace '${scope.namespace}' is in ${space.spaceId}`
    })
  }
  if (query.length !== space.dimensions) {
    throw new QvacErrorRAG({
      code: ERR_CODES.EMBEDDING_DIMENSION_MISMATCH,
      adds: `query has ${query.length} dimensions, namespace '${scope.namespace}' expects ${space.dimensions}`
    })
  }
}

// A namespace stores 4 bytes per dimension, or 2 for 'f16'.
export function checkStoredVector(chunk: ChunkRecord, dims: number): void {
  if (chunk.vector.byteLength !== dims * 4 && chunk.vector.byteLength !== dims * 2) {
    throw new QvacErrorRAG({
      code: ERR_CODES.DB_OPERATION_FAILED,
      adds: `stored vector for '${chunk.documentId}' chunk ${chunk.ordinal} has the wrong size`
    })
  }
}

// Reads each hit's document once, from the same snapshot as the scan, and
// fills the fields that come from it: chunk count, metadata and citation.
export async function attachDocumentDetails(
  reader: HyperDBReader,
  namespace: string,
  hits: SearchHit[]
): Promise<void> {
  const documentIds = Array.from(new Set(hits.map((hit) => hit.documentId)))
  const documents = await Promise.all(
    documentIds.map((documentId) =>
      reader.get<DocumentRecord>(DOCUMENTS, { namespace, documentId })
    )
  )
  const byId = new Map<string, DocumentRecord>()
  documents.forEach((document, i) => {
    if (document) byId.set(documentIds[i], document)
  })
  for (const hit of hits) {
    const document = byId.get(hit.documentId)
    if (!document) continue
    hit.chunkCount = document.chunkCount
    if (document.metadata) hit.documentMetadata = document.metadata
    hit.citation = citationOf(document.metadata, hit.metadataJson)
  }
}

const SOURCE_KEYS = ['title', 'sourceUrl', 'sourcePath', 'mimeType'] as const

// Document metadata wins over chunk metadata (the rag-extract chunk format
// carries the same keys); `page` is per chunk. Only well-typed values are lifted.
export function citationOf(
  documentMetadata: Record<string, unknown> | undefined,
  metadataJson: string | undefined
): SearchCitation {
  const chunk = parseObject(metadataJson)
  const citation: SearchCitation = {}
  for (const key of SOURCE_KEYS) {
    const value = nonEmptyString(documentMetadata?.[key]) ?? nonEmptyString(chunk?.[key])
    if (value !== undefined) citation[key] = value
  }
  const page = chunk?.page
  if (typeof page === 'number' && Number.isSafeInteger(page) && page >= 1) citation.page = page
  return citation
}

function parseObject(json: string | undefined): Record<string, unknown> | null {
  if (json === undefined) return null
  try {
    const value: unknown = JSON.parse(json)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// Resolves the scope to key ranges over current-generation chunks.
async function resolveRanges(
  reader: HyperDBReader,
  scope: SearchScope,
  strict: boolean
): Promise<object[]> {
  const { namespace, documentIds } = scope
  if (documentIds === undefined) {
    return [{ gte: { namespace }, lte: { namespace } }]
  }
  return (await resolveDocuments(reader, scope, strict)).map((document) => {
    const key = { namespace, documentId: document.documentId, generation: document.generation }
    return { gte: key, lte: key }
  })
}

// Reads the scope's documents. When `strict`, a document that isn't in the
// namespace fails the whole search; otherwise it is skipped, so a bound scope
// whose documents were deleted degrades to fewer or no hits instead of an error.
export async function resolveDocuments(
  reader: HyperDBReader,
  scope: SearchScope,
  strict: boolean
): Promise<DocumentRecord[]> {
  const { namespace, documentIds = [] } = scope
  const documents = await Promise.all(
    documentIds.map((documentId) =>
      reader.get<DocumentRecord>(DOCUMENTS, { namespace, documentId })
    )
  )
  const found: DocumentRecord[] = []
  documents.forEach((document, i) => {
    if (document) {
      found.push(document)
      return
    }
    if (!strict) return
    throw new QvacErrorRAG({
      code: ERR_CODES.DOCUMENT_OUT_OF_SCOPE,
      adds: `'${documentIds[i]}' in '${namespace}'`
    })
  })
  return found
}

// Cached rows resolve through microtasks alone, so without a turn of the event
// loop an abort scheduled by a timer or UI event could never run mid-scan.
export async function yieldForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return
  await new Promise<void>((resolve) => {
    if (timers.setImmediate) timers.setImmediate(resolve)
    else timers.setTimeout(resolve, 0)
  })
  throwIfAborted(signal)
}

// Timers are runtime globals on Bare, Node, React Native and browsers, but the
// package compiles without platform typings.
const timers = globalThis as unknown as {
  setImmediate?: (callback: () => void) => unknown
  setTimeout: (callback: () => void, ms: number) => unknown
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
}

function offer(top: Ranked[], k: number, score: number, chunk: ChunkRecord): void {
  if (top.length === k && score <= top[top.length - 1].score) return

  // Ties keep scan order: a new entry goes after every equal score.
  let low = 0
  let high = top.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (top[mid].score >= score) low = mid + 1
    else high = mid
  }
  top.splice(low, 0, { score, hit: toHit(chunk, score) })
  if (top.length > k) top.pop()
}

export function toHit(chunk: ChunkRecord, score: number): SearchHit {
  const hit: SearchHit = {
    namespace: chunk.namespace,
    documentId: chunk.documentId,
    chunkId: chunk.chunkId,
    ordinal: chunk.ordinal,
    generation: chunk.generation,
    chunkCount: 0,
    content: chunk.content,
    citation: {},
    score
  }
  if (typeof chunk.metadataJson === 'string') hit.metadataJson = chunk.metadataJson
  return hit
}

export function dot(query: Float32Array, vectors: Float32Array, offset: number): number {
  let sum = 0
  for (let i = 0; i < query.length; i++) sum += query[i] * vectors[offset + i]
  return sum
}

export function norm(vectors: Float32Array, offset: number, length: number): number {
  let sum = 0
  for (let i = 0; i < length; i++) sum += vectors[offset + i] * vectors[offset + i]
  return Math.sqrt(sum)
}
