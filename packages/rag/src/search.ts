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
  query: Float32Array,
  k: number,
  options: { strict: boolean }
): Promise<SearchHit[]> {
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
      if (batch.length === SCAN_BATCH_SIZE) scoreBatch()
    }
  }
  scoreBatch()

  return top.map((entry) => entry.hit)
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
