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
import type { SearchHit, SearchScope } from './types.js'

// Rows decoded and scored per step; memory stays bounded by this and k.
export const SCAN_BATCH_SIZE = 256

export interface SearchQuery {
  vector: Float32Array
  spaceId: string
}

interface Ranked {
  score: number
  hit: SearchHit
}

// Exact scan over the chunks inside `scope`. Out-of-scope rows are never read,
// so only allowed chunks compete for the top k.
export async function scanSearch(
  reader: HyperDBReader,
  space: SpaceRecord,
  scope: SearchScope,
  { vector: query, spaceId }: SearchQuery,
  k: number,
  options: { strict: boolean; signal?: AbortSignal }
): Promise<SearchHit[]> {
  throwIfAborted(options.signal)
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
  if (scope.documentIds !== undefined && scope.documentIds.length === 0) return []

  const ranges = await resolveRanges(reader, scope, options.strict)
  const cosine = space.metric === 'cosine'
  const queryNorm = cosine ? norm(query, 0, query.length) : 1
  const dims = space.dimensions
  const vectors = new Float32Array(SCAN_BATCH_SIZE * dims)
  const batch: ChunkRecord[] = []
  const top: Ranked[] = []

  function scoreBatch() {
    for (let row = 0; row < batch.length; row++) {
      const offset = row * dims
      let score = dot(query, vectors, offset)
      if (cosine) {
        const denominator = queryNorm * norm(vectors, offset, dims)
        score = denominator === 0 ? 0 : score / denominator
      }
      offer(top, k, score, batch[row])
    }
    batch.length = 0
  }

  for (const range of ranges) {
    for await (const chunk of reader.find<ChunkRecord>(CHUNKS, range)) {
      if (chunk.vector.byteLength !== dims * 4) {
        throw new QvacErrorRAG({
          code: ERR_CODES.DB_OPERATION_FAILED,
          adds: `stored vector for '${chunk.documentId}' chunk ${chunk.ordinal} has the wrong size`
        })
      }
      decodeVectorInto(chunk.vector, vectors, batch.length * dims)
      batch.push(chunk)
      if (batch.length === SCAN_BATCH_SIZE) {
        scoreBatch()
        await yieldForAbort(options.signal)
      }
    }
  }
  scoreBatch()
  throwIfAborted(options.signal)

  const hits = top.map((entry) => entry.hit)
  await attachDocumentMetadata(reader, scope.namespace, hits)
  return hits
}

// Reads each hit's document once, from the same snapshot as the scan.
async function attachDocumentMetadata(
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
  const metadata = new Map<string, Record<string, unknown>>()
  documents.forEach((document, i) => {
    if (document?.metadata) metadata.set(documentIds[i], document.metadata)
  })
  for (const hit of hits) {
    const value = metadata.get(hit.documentId)
    if (value) hit.documentMetadata = value
  }
}

// Resolves the scope to key ranges over current-generation chunks. When
// `strict`, a document that isn't in the namespace fails the whole search;
// otherwise it is skipped, so a bound scope whose documents were deleted
// degrades to fewer or no hits instead of an error.
async function resolveRanges(
  reader: HyperDBReader,
  scope: SearchScope,
  strict: boolean
): Promise<object[]> {
  const { namespace, documentIds } = scope
  if (documentIds === undefined) {
    return [{ gte: { namespace }, lte: { namespace } }]
  }
  const documents = await Promise.all(
    documentIds.map((documentId) =>
      reader.get<DocumentRecord>(DOCUMENTS, { namespace, documentId })
    )
  )
  const ranges: object[] = []
  documents.forEach((document, i) => {
    if (!document) {
      if (!strict) return
      throw new QvacErrorRAG({
        code: ERR_CODES.DOCUMENT_OUT_OF_SCOPE,
        adds: `'${documentIds[i]}' in '${namespace}'`
      })
    }
    const key = { namespace, documentId: document.documentId, generation: document.generation }
    ranges.push({ gte: key, lte: key })
  })
  return ranges
}

// Cached rows resolve through microtasks alone, so without a turn of the event
// loop an abort scheduled by a timer or UI event could never run mid-scan.
async function yieldForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return
  await new Promise<void>((resolve) =>
    typeof setImmediate === 'function' ? setImmediate(resolve) : setTimeout(resolve, 0)
  )
  throwIfAborted(signal)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
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
  const hit: SearchHit = {
    namespace: chunk.namespace,
    documentId: chunk.documentId,
    chunkId: chunk.chunkId,
    ordinal: chunk.ordinal,
    content: chunk.content,
    score
  }
  if (typeof chunk.metadataJson === 'string') hit.metadataJson = chunk.metadataJson
  top.splice(low, 0, { score, hit })
  if (top.length > k) top.pop()
}

function dot(query: Float32Array, vectors: Float32Array, offset: number): number {
  let sum = 0
  for (let i = 0; i < query.length; i++) sum += query[i] * vectors[offset + i]
  return sum
}

function norm(vectors: Float32Array, offset: number, length: number): number {
  let sum = 0
  for (let i = 0; i < length; i++) sum += vectors[offset + i] * vectors[offset + i]
  return Math.sqrt(sum)
}
