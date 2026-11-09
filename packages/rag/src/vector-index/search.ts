import { decodeNativeId, decodeVectorInto, encodeNativeId } from '../db/encoding.js'
import {
  CHUNKS,
  NATIVE_IDS,
  type ChunkRecord,
  type DocumentRecord,
  type NativeIdRecord,
  type SpaceRecord
} from '../db/records.js'
import {
  attachDocumentMetadata,
  checkQuery,
  checkStoredVector,
  dot,
  norm,
  resolveDocuments,
  throwIfAborted,
  toHit,
  type SearchQuery
} from '../search.js'
import { PADDING_ID } from './native.js'
import { normalizeRows, type OpenIndex } from './registry.js'
import type { HyperDBReader } from '../db/db-types.js'
import type { SearchHit, SearchScope } from '../types.js'

// Extra candidates fetched past k. They are rescored exactly from the stored
// vectors, which absorbs quantization error and IDs the reader doesn't know.
const MIN_EXTRA_CANDIDATES = 16

// Index search with the same contract as `scanSearch`. The index proposes
// candidates; every hit is then read back through `nativeIds` from the same
// HyperDB snapshot and scored exactly. An ID the snapshot doesn't map to a
// current chunk in scope is dropped, never returned. Returns null when no
// index is available, so the caller can scan instead.
export async function indexSearch(
  reader: HyperDBReader,
  space: SpaceRecord,
  scope: SearchScope,
  query: SearchQuery,
  k: number,
  openIndex: () => Promise<OpenIndex | null>,
  options: { strict: boolean; signal?: AbortSignal }
): Promise<SearchHit[] | null> {
  throwIfAborted(options.signal)
  checkQuery(space, scope, query)
  if (scope.documentIds !== undefined && scope.documentIds.length === 0) return []

  const { namespace } = scope
  let allowed: Set<string> | null = null
  let allowlist: BigUint64Array | null = null
  if (scope.documentIds !== undefined) {
    const documents = await resolveDocuments(reader, scope, options.strict)
    allowed = new Set(documents.map((document) => document.documentId))
    allowlist = await nativeIdsOf(reader, documents)
    if (allowlist.length === 0) return []
  }

  // Opened last: a rebuild started by another search may dispose the native
  // index it replaces, so nothing awaits between this and the native search.
  const index = await openIndex()
  if (!index) return null
  const available = allowlist ? allowlist.length : index.native.length
  const candidates = Math.min(available, k + Math.max(k, MIN_EXTRA_CANDIDATES))
  if (candidates === 0) return []

  const dims = space.dimensions
  const vector = query.vector.slice()
  if (index.normalize) normalizeRows(vector, dims)
  const result = allowlist
    ? index.native.searchFiltered(vector, candidates, allowlist)
    : index.native.search(vector, candidates)

  const cosine = space.metric === 'cosine'
  const queryNorm = cosine ? norm(query.vector, 0, dims) : 1
  const stored = new Float32Array(dims)
  const hits: SearchHit[] = []
  for (let slot = 0; slot < result.k; slot++) {
    const id = result.ids[slot]
    if (id === PADDING_ID) break
    const chunk = await readChunk(reader, namespace, id)
    if (!chunk || (allowed && !allowed.has(chunk.documentId))) continue
    checkStoredVector(chunk, dims)
    decodeVectorInto(chunk.vector, stored, 0)
    let score = dot(query.vector, stored, 0)
    if (cosine) {
      const denominator = queryNorm * norm(stored, 0, dims)
      score = denominator === 0 ? 0 : score / denominator
    }
    hits.push(toHit(chunk, score))
  }
  throwIfAborted(options.signal)

  hits.sort(compareHits)
  if (hits.length > k) hits.length = k
  await attachDocumentMetadata(reader, namespace, hits)
  return hits
}

// Ties fall back to key order, as in a namespace scan.
function compareHits(a: SearchHit, b: SearchHit): number {
  if (a.score !== b.score) return b.score - a.score
  if (a.documentId !== b.documentId) return a.documentId < b.documentId ? -1 : 1
  return a.ordinal - b.ordinal
}

async function readChunk(
  reader: HyperDBReader,
  namespace: string,
  id: bigint
): Promise<ChunkRecord | null> {
  const row = await reader.get<NativeIdRecord>(NATIVE_IDS, {
    namespace,
    nativeId: encodeNativeId(id)
  })
  if (!row) return null
  return await reader.get<ChunkRecord>(CHUNKS, {
    namespace,
    documentId: row.documentId,
    generation: row.generation,
    ordinal: row.ordinal
  })
}

// A generation's native IDs are allocated in one run, so two reads usually
// give the whole range. Anything else falls back to reading every chunk.
async function nativeIdsOf(
  reader: HyperDBReader,
  documents: DocumentRecord[]
): Promise<BigUint64Array> {
  const ids: bigint[] = []
  for (const document of documents) {
    const { namespace, documentId, generation, chunkCount } = document
    if (chunkCount === 0) continue
    const key = { namespace, documentId, generation }
    const [first, last] = await Promise.all([
      reader.get<ChunkRecord>(CHUNKS, { ...key, ordinal: 0 }),
      reader.get<ChunkRecord>(CHUNKS, { ...key, ordinal: chunkCount - 1 })
    ])
    if (first && last) {
      const start = decodeNativeId(first.nativeId)
      if (decodeNativeId(last.nativeId) - start === BigInt(chunkCount - 1)) {
        for (let i = 0; i < chunkCount; i++) ids.push(start + BigInt(i))
        continue
      }
    }
    for await (const chunk of reader.find<ChunkRecord>(CHUNKS, { gte: key, lte: key })) {
      ids.push(decodeNativeId(chunk.nativeId))
    }
  }
  return BigUint64Array.from(ids)
}
