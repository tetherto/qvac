import { decodeNativeId, decodeVectorInto, encodeNativeId } from '../db/encoding.js'
import {
  CHUNKS,
  DOCUMENTS,
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
// that factor while the cap leaves fewer than k hits. With `minScore` too,
// growth stops once every candidate in the margin past the pool scores below
// the floor: the margin is what absorbs quantization order, as for plain top k.
const POOL_GROWTH = 4
const MAX_POOL = 4096
// Each round rereads its whole window by point lookups, which cost more per row
// than the scan's range reads. Once the next window would reach 1/SCAN_SHARE of
// the rows in scope, or can't grow past MAX_POOL, the exact scan answers instead.
const SCAN_SHARE = 8

// Index search with the same contract as `scanSearch`. The index proposes
// candidates; every hit is then read back through `nativeIds` from the same
// HyperDB snapshot and scored exactly. An ID the snapshot doesn't map to a
// current chunk in scope is dropped, never returned.
//
// The index must be at the reader's revision: an index ahead of the reader
// holds IDs the reader can't map and lacks the ones it replaced. Returns
// 'stale' then, so the caller retries on a fresh reader, and 'unavailable'
// when there is no index at all or its search failed.
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

  const { perDocument, minScore } = options

  // The top `want` candidates, rescored exactly and sorted.
  async function candidates(
    want: number
  ): Promise<
    { hits: SearchHit[]; available: number; pastFloor: boolean } | 'stale' | 'unavailable'
  > {
    const index = await untilAborted(openIndex(), options.signal)
    if (!index) return 'unavailable'
    if (index.revision() !== revision) return 'stale'
    if (index.storage.startsWith('turbovec-') && !index.normalize && !quantizable(query.vector)) {
      return 'unavailable'
    }
    const available = allowlist ? allowlist.length : index.rows()
    if (available === 0) return { hits: [], available, pastFloor: true }

    const vector = query.vector.slice()
    if (index.normalize) normalizeRows(vector, dims)
    const result = await searchCandidates(index, revision, vector, want, allowlist)
    if (typeof result === 'string') return result
    const hits: SearchHit[] = []
    let margin = 0
    let marginBelow = 0
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
      if (slot >= want) {
        margin++
        if (minScore !== undefined && score < minScore) marginBelow++
      }
    }
    throwIfAborted(options.signal)
    const pastFloor = minScore !== undefined && margin > 0 && marginBelow === margin
    return { hits: sortHits(hits, scope), available, pastFloor }
  }

  const listed = scope.documentIds === undefined ? null : documents
  let pool = perDocument === undefined ? k : Math.max(k, Math.min(MAX_POOL, k * POOL_GROWTH))
  let selected: SearchHit[]
  for (;;) {
    const found = await candidates(pool)
    if (typeof found === 'string') return found
    const ranked =
      minScore === undefined ? found.hits : found.hits.filter((hit) => hit.score >= minScore)
    if (perDocument === undefined) {
      selected = ranked.slice(0, k)
      break
    }
    selected = selectDiverse(ranked, k, perDocument)
    if (found.pastFloor || pool >= found.available) break
    const window = { hits: found.hits, ranked }
    if (await selectionComplete(reader, namespace, listed, window, k, perDocument)) break
    const next = Math.min(MAX_POOL, pool * POOL_GROWTH)
    if (next === pool || next * SCAN_SHARE >= found.available) {
      return await scanSearch(reader, space, scope, query, k, options)
    }
    pool = next
  }

  await attachDocumentDetails(reader, namespace, selected)
  return selected
}

// Whether `selectDiverse` over the window equals the selection over the whole
// scope. Hits outside the window score below all of it, so a document that may
// hold more of them takes its next hit last in its round, and a document with
// none in the window comes after every other in the first round. The window is
// complete when k fills before any such turn comes up.
async function selectionComplete(
  reader: HyperDBReader,
  namespace: string,
  listed: DocumentRecord[] | null,
  window: { hits: SearchHit[]; ranked: SearchHit[] },
  k: number,
  perDocument: number
): Promise<boolean> {
  const inWindow = countByDocument(window.hits)
  const inRanked = countByDocument(window.ranked)
  const chunkCounts = new Map(listed?.map((document) => [document.documentId, document.chunkCount]))

  // A window hit below `minScore` puts the document's later chunks below it too.
  async function mayHoldMore(documentId: string, count: number): Promise<boolean> {
    if (count < (inWindow.get(documentId) ?? 0)) return false
    let chunkCount = chunkCounts.get(documentId)
    if (chunkCount === undefined) {
      const document = await reader.get<DocumentRecord>(DOCUMENTS, { namespace, documentId })
      chunkCount = document?.chunkCount ?? 0
      chunkCounts.set(documentId, chunkCount)
    }
    return chunkCount > count
  }

  let chosen = 0
  for (let round = 0; round < perDocument && chosen < k; round++) {
    const before = chosen
    for (const [documentId, count] of inRanked) {
      if (chosen === k) return true
      if (round < count) chosen++
      else if (round === count && (await mayHoldMore(documentId, count))) return false
    }
    if (round === 0 && chosen < k && (await anyOutside(reader, namespace, listed, inWindow))) {
      return false
    }
    // Every document is out of window hits; later rounds can't change anything.
    if (chosen === before) break
  }
  return true
}

// Insertion order is first appearance, which is the order `selectDiverse` seats in.
function countByDocument(hits: SearchHit[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const hit of hits) counts.set(hit.documentId, (counts.get(hit.documentId) ?? 0) + 1)
  return counts
}

// A namespace read stops at the first document with no hit in the window.
async function anyOutside(
  reader: HyperDBReader,
  namespace: string,
  listed: DocumentRecord[] | null,
  inWindow: Map<string, number>
): Promise<boolean> {
  const outside = (document: DocumentRecord) =>
    document.chunkCount > 0 && !inWindow.has(document.documentId)
  if (listed) return listed.some(outside)
  const range = { gte: { namespace }, lte: { namespace } }
  for await (const document of reader.find<DocumentRecord>(DOCUMENTS, range)) {
    if (outside(document)) return true
  }
  return false
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
async function searchCandidates(
  index: OpenIndex,
  revision: number,
  vector: Float32Array,
  k: number,
  allowlist: BigUint64Array | null
): Promise<NativeSearchResult | 'stale' | 'unavailable'> {
  let want = k + Math.max(k, MIN_EXTRA_CANDIDATES)
  for (;;) {
    const available = allowlist ? allowlist.length : index.rows()
    want = Math.min(available, want)
    // No rows: the index was replaced since the last round.
    if (want === 0) return 'stale'
    const result = await index.search(revision, vector, want, allowlist)
    if (typeof result === 'string') return result
    let count = 0
    while (count < result.k && result.ids[count] !== PADDING_ID) count++
    if (count < want || want === available) return result
    if (result.scores[count - 1] < result.scores[Math.min(k, count) - 1]) return result
    want *= 2
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
