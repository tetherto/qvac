import { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import { QvacErrorBase } from '@qvac/error'
import { getVectorIndexProvider } from '@/plugins/registry'
import type { VectorIndexBackend } from '@/schemas/plugin'
import { getConfiguredCacheDir } from '@/runtime/state'
import { generateRandomRequestId } from '@/runtime/request-id'
import { getEngineLogger } from '@/logging/index'
import {
  readVectorIndexStorage,
  VECTOR_ID_RESERVED,
  type VectorIdWire,
  type VectorIndexHit,
  type VectorIndexStorage
} from '@/schemas/index'
import {
  VectorIndexFailedError,
  VectorIndexInvalidVectorsError,
  VectorIndexNotFoundError,
  VectorIndexProviderUnavailableError
} from '@/errors/index'

interface VectorIndexEntry {
  index: VectorIndexBackend
  storage: VectorIndexStorage | undefined
  // TurboVec precomputes rotation and codebook state on the first search
  // after a mutation; running it eagerly keeps that cost out of the first
  // query's latency.
  needsPrepare: boolean
}

const PADDING_ID = BigInt(VECTOR_ID_RESERVED)
const indexes = new Map<string, VectorIndexEntry>()

function requireProvider() {
  const provider = getVectorIndexProvider()
  if (!provider) throw new VectorIndexProviderUnavailableError()
  return provider
}

function getEntry(indexId: string): VectorIndexEntry {
  const entry = indexes.get(indexId)
  if (!entry) throw new VectorIndexNotFoundError(indexId)
  return entry
}

// The addon throws plain TypeError/RangeError/Error values; wrap them so the
// caller receives a coded error with the native message preserved as cause.
function runNative<T>(action: () => T): T {
  try {
    return action()
  } catch (error) {
    if (error instanceof QvacErrorBase) throw error
    throw new VectorIndexFailedError(error instanceof Error ? error.message : String(error), error)
  }
}

/**
 * Snapshot paths are used as given when absolute. A relative path resolves
 * against the QVAC data directory (the parent of the configured cache
 * directory), the same root that holds the RAG workspace stores, so the
 * same relative path works on every platform.
 */
export function resolveVectorIndexPath(snapshotPath: string): string {
  if (path.isAbsolute(snapshotPath)) return snapshotPath
  return path.join(path.dirname(getConfiguredCacheDir()), snapshotPath)
}

function flattenRows(rows: number[][], dim: number, label: 'vectors' | 'queries'): Float32Array {
  const flat = new Float32Array(rows.length * dim)
  rows.forEach((row, rowIndex) => {
    if (row.length !== dim) {
      throw new VectorIndexInvalidVectorsError(
        `${label}[${rowIndex}] has ${row.length} components, expected ${dim}`
      )
    }
    flat.set(row, rowIndex * dim)
  })
  return flat
}

function toNativeIds(ids: VectorIdWire[]): BigUint64Array {
  return new BigUint64Array(ids.map((id) => BigInt(id)))
}

function registerIndex(index: VectorIndexBackend, storage: VectorIndexStorage | undefined) {
  const indexId = generateRandomRequestId()
  indexes.set(indexId, { index, storage, needsPrepare: true })
  return indexId
}

export function createVectorIndex(params: { dim: number; storage: VectorIndexStorage }) {
  const provider = requireProvider()
  const index = runNative(() => provider.create({ dim: params.dim, storage: params.storage }))
  const indexId = registerIndex(index, params.storage)
  return { indexId, dim: index.dim, storage: params.storage, length: index.length }
}

export function loadVectorIndex(params: { path: string }) {
  const provider = requireProvider()
  const snapshotPath = resolveVectorIndexPath(params.path)
  const index = runNative(() => provider.load(snapshotPath))
  const storage = readVectorIndexStorage((index as { storage?: unknown }).storage)
  const indexId = registerIndex(index, storage)
  return {
    indexId,
    dim: index.dim,
    length: index.length,
    ...(storage !== undefined && { storage })
  }
}

export function addVectors(params: { indexId: string; ids: VectorIdWire[]; vectors: number[][] }) {
  const entry = getEntry(params.indexId)
  if (params.ids.length !== params.vectors.length) {
    throw new VectorIndexInvalidVectorsError(
      `ids has ${params.ids.length} entries but vectors has ${params.vectors.length} rows`
    )
  }
  const vectors = flattenRows(params.vectors, entry.index.dim, 'vectors')
  const ids = toNativeIds(params.ids)
  runNative(() => entry.index.addWithIds(vectors, ids))
  entry.needsPrepare = true
  return { length: entry.index.length }
}

export function searchVectors(params: { indexId: string; queries: number[][]; k: number }) {
  const entry = getEntry(params.indexId)
  const queries = flattenRows(params.queries, entry.index.dim, 'queries')
  if (entry.needsPrepare) {
    runNative(() => entry.index.prepare())
    entry.needsPrepare = false
  }
  const result = runNative(() => entry.index.search(queries, params.k))
  const results: VectorIndexHit[][] = []
  for (let row = 0; row < result.m; row++) {
    const hits: VectorIndexHit[] = []
    for (let slot = 0; slot < result.k; slot++) {
      const offset = row * result.k + slot
      const id = result.ids[offset]
      if (id === undefined || id === PADDING_ID) break
      hits.push({ id: id.toString(), score: result.scores[offset] ?? 0 })
    }
    results.push(hits)
  }
  return { results }
}

export function removeVectors(params: { indexId: string; ids: VectorIdWire[] }) {
  const entry = getEntry(params.indexId)
  const removed = params.ids.map((id) => runNative(() => entry.index.remove(BigInt(id))))
  if (removed.some(Boolean)) entry.needsPrepare = true
  return { removed, length: entry.index.length }
}

export function containsVectors(params: { indexId: string; ids: VectorIdWire[] }) {
  const entry = getEntry(params.indexId)
  const present = params.ids.map((id) => runNative(() => entry.index.contains(BigInt(id))))
  return { present }
}

export async function writeVectorIndex(params: { indexId: string; path: string }) {
  const entry = getEntry(params.indexId)
  const snapshotPath = resolveVectorIndexPath(params.path)
  await fsPromises.mkdir(path.dirname(snapshotPath), { recursive: true })
  runNative(() => entry.index.write(snapshotPath))
  return { path: snapshotPath }
}

// Disposing an unknown id is not an error: the caller may retry after a
// worker restart, and the memory it refers to is already gone.
export function disposeVectorIndex(params: { indexId: string }) {
  const entry = indexes.get(params.indexId)
  if (!entry) return { disposed: false }
  indexes.delete(params.indexId)
  runNative(() => entry.index.dispose())
  return { disposed: true }
}

export function getOpenVectorIndexCount() {
  return indexes.size
}

export function disposeAllVectorIndexes() {
  for (const [indexId, entry] of indexes) {
    try {
      entry.index.dispose()
    } catch (error) {
      getEngineLogger().warn(`Failed to dispose vector index '${indexId}' during cleanup:`, error)
    }
  }
  indexes.clear()
}
