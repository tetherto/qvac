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
  attachDocumentDetails,
  checkQuery,
  checkStoredVector,
  dot,
  norm,
  resolveDocuments,
  scanSearch,
  sortHits,
  throwIfAborted,
  toHit,
  type SearchOptions,
  type SearchQuery
} from '../search.js'
import { selectDiverse } from '../diversify.js'
import { QvacErrorRAG, ERR_CODES } from '../errors.js'
import { PADDING_ID, TURBOVEC_MAX_COMPONENT, type NativeSearchResult } from './native.js'
import { normalizeRows, type OpenIndex } from './registry.js'
import type { HyperDBReader } from '../db/db-types.js'
import type { SearchHit, SearchScope } from '../types.js'

// Extra candidates fetched past k. They are rescored exactly from the stored
// vectors, which absorbs quantization error and IDs the reader doesn't know.
const MIN_EXTRA_CANDIDATES = 16

// With `perDocument`, the pool starts at k × POOL_GROWTH candidates and grows by
// that factor while the cap leaves fewer than k hits, up to MAX_POOL. With
// `minScore` too, growth stops once the last candidate falls below the floor.
const POOL_GROWTH = 4
const MAX_POOL = 4096

// Index search with the same contract as `scanSearch`. The index proposes
// candidates; every hit is then read back through `nativeIds` from the same
// HyperDB snapshot and scored exactly. An ID the snapshot doesn't map to a
// current chunk in scope is dropped, never returned.
//
// The index must be at the reader's revision: an index ahead of the reader
// holds IDs the reader can't map and lacks the ones it replaced. Returns
// 'stale' then, so the caller retries on a fresh reader, and 'unavailable'
// when there is no index at all.
export async function indexSearch(
  reader: HyperDBReader,
  revision: number,
  space: SpaceRecord,
  scope: SearchScope,
  query: SearchQuery,
  k: number,
  openIndex: () => Promise<OpenIndex | null>,
  options: SearchOptions
): Promise<SearchHit[] | 'stale' | 'unavailable'> {
  throwIfAborted(options.signal)
  checkQuery(space, scope, query)
  if (scope.documentIds !== undefined && scope.documentIds.length === 0) return []

  const { namespace } = scope
  let allowed: Set<string> | null = null
  let allowlist: BigUint64Array | null = null
  let documents: DocumentRecord[] = []
  if (scope.documentIds !== undefined) {
    documents = await resolveDocuments(reader, scope, options.strict)
    allowed = new Set(documents.map((document) => document.documentId))
    allowlist = await nativeIdsOf(reader, documents)
    if (allowlist.length === 0) return []
  }

  const dims = space.dimensions
  const cosine = space.metric === 'cosine'
  const queryNorm = cosine ? norm(query.vector, 0, dims) : 1
  const stored = new Float32Array(dims)

  // The top `want` candidates, rescored exactly and sorted. Each call opens the
  // index last: a rebuild started by another search may dispose the native
  // index it replaces, so nothing awaits between the open and the native search.
  async function candidates(
    want: number
  ): Promise<{ hits: SearchHit[]; available: number } | 'stale' | 'unavailable'> {
    const index = await untilAborted(openIndex(), options.signal)
    if (!index) return 'unavailable'
    if (index.revision() !== revision) return 'stale'
    if (index.storage.startsWith('turbovec-') && !index.normalize && !quantizable(query.vector)) {
      return 'unavailable'
    }
    const available = allowlist ? allowlist.length : index.native.length
    if (available === 0) return { hits: [], available }

    const vector = query.vector.slice()
    if (index.normalize) normalizeRows(vector, dims)
    let result: NativeSearchResult
    try {
      result = searchCandidates(index, vector, want, available, allowlist)
    } catch {
      index.fail()
      return 'unavailable'
    }
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
    return { hits: sortHits(hits, scope), available }
  }

  const { perDocument, minScore } = options
  let pool = perDocument === undefined ? k : Math.max(k, Math.min(MAX_POOL, k * POOL_GROWTH))
  let ranked: SearchHit[]
  let selected: SearchHit[]
  for (;;) {
    const found = await candidates(pool)
    if (typeof found === 'string') return found
    ranked = minScore === undefined ? found.hits : found.hits.filter((hit) => hit.score >= minScore)
    if (perDocument === undefined) {
      selected = ranked.slice(0, k)
      break
    }
    selected = selectDiverse(ranked, k, perDocument)
    const last = found.hits[found.hits.length - 1]
    const pastFloor = minScore !== undefined && (!last || last.score < minScore)
    if (selected.length === k || pastFloor || pool >= found.available || pool >= MAX_POOL) break
    pool = Math.min(MAX_POOL, pool * POOL_GROWTH)
  }

  // Listed documents the pool missed get their best chunk from an exact scan,
  // so every one of them can be seated.
  if (perDocument !== undefined && documents.length > 0 && documents.length <= k) {
    const present = new Set(ranked.map((hit) => hit.documentId))
    const missing = documents
      .filter((document) => document.chunkCount > 0 && !present.has(document.documentId))
      .map((document) => document.documentId)
    if (missing.length > 0) {
      const best = await scanSearch(
        reader,
        space,
        { namespace, documentIds: missing },
        query,
        missing.length,
        { strict: false, perDocument: 1, minScore, signal: options.signal }
      )
      selected = selectDiverse(sortHits(ranked.concat(best), scope), k, perDocument)
    }
  }
  await attachDocumentDetails(reader, namespace, selected)
  return selected
}

// A query TurboVec can't rotate is still a valid query; the scan answers it.
function quantizable(vector: Float32Array): boolean {
  for (let i = 0; i < vector.length; i++) {
    if (Math.abs(vector[i]) >= TURBOVEC_MAX_COMPONENT) return false
  }
  return true
}

// Native results break ties by native ID, which is not the scan's order. When
// the candidate cutoff ties with the k-th candidate, more rows may share that
// score, so the window widens until it no longer cuts through the tie.
function searchCandidates(
  index: OpenIndex,
  vector: Float32Array,
  k: number,
  available: number,
  allowlist: BigUint64Array | null
): NativeSearchResult {
  let want = Math.min(available, k + Math.max(k, MIN_EXTRA_CANDIDATES))
  for (;;) {
    const result = allowlist
      ? index.native.searchFiltered(vector, want, allowlist)
      : index.native.search(vector, want)
    let count = 0
    while (count < result.k && result.ids[count] !== PADDING_ID) count++
    if (count < want || want === available) return result
    if (result.scores[count - 1] < result.scores[Math.min(k, count) - 1]) return result
    want = Math.min(available, want * 2)
  }
}

// Stops waiting for the index on abort; a rebuild already running finishes
// for the next search.
async function untilAborted<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return await pending
  pending.catch(() => {})
  throwIfAborted(signal)
  let onAbort = () => {}
  const aborted = new Promise<never>((resolve, reject) => {
    onAbort = () => reject(new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED }))
    signal.addEventListener('abort', onAbort)
  })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
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
