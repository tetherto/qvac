import { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import { QvacErrorBase } from '@qvac/error'
import { getTurboVecBackend } from '@/plugins/turbovec-backend'
import type { OpenVectorIndex, VectorIndexBackend } from '@/runtime/vector-index-backend'
import { getConfiguredCacheDir } from '@/runtime/state'
import { generateRandomRequestId } from '@/runtime/request-id'
import { getEngineLogger } from '@/logging/index'
import type { VectorIdWire, VectorIndexStorage } from '@/schemas/index'
import {
  VectorIndexFailedError,
  VectorIndexInvalidVectorsError,
  VectorIndexNotFoundError,
  VectorIndexProviderUnavailableError
} from '@/errors/index'

// Worker-side bookkeeping for open indexes: ids, wire-to-native conversion,
// row validation, snapshot paths, and lifetime. Engine behaviour lives in
// the backend.
const indexes = new Map<string, OpenVectorIndex>()

function requireBackend(): VectorIndexBackend {
  const backend = getTurboVecBackend()
  if (!backend) throw new VectorIndexProviderUnavailableError()
  return backend
}

function getIndex(indexId: string): OpenVectorIndex {
  const index = indexes.get(indexId)
  if (!index) throw new VectorIndexNotFoundError(indexId)
  return index
}

// Backends throw plain TypeError/RangeError/Error values from the native
// layer; wrap them so the caller receives a coded error with the original
// message preserved as cause. `describe` adds caller context to the message
// and is evaluated at throw time, so it can report progress made so far.
function runBackend<T>(action: () => T, describe?: (detail: string) => string): T {
  try {
    return action()
  } catch (error) {
    if (error instanceof QvacErrorBase) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new VectorIndexFailedError(describe ? describe(detail) : detail, error)
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

function track(index: OpenVectorIndex) {
  const indexId = generateRandomRequestId()
  indexes.set(indexId, index)
  return indexId
}

export function createVectorIndex(params: { dim: number; storage: VectorIndexStorage }) {
  const backend = requireBackend()
  const index = runBackend(() => backend.create(params.dim, params.storage))
  const indexId = track(index)
  return { indexId, dim: index.dim, storage: params.storage, length: index.length }
}

export function loadVectorIndex(params: { path: string }) {
  const backend = requireBackend()
  const index = runBackend(() => backend.load(resolveVectorIndexPath(params.path)))
  const indexId = track(index)
  return {
    indexId,
    dim: index.dim,
    length: index.length,
    ...(index.storage !== undefined && { storage: index.storage })
  }
}

export function addVectors(params: { indexId: string; ids: VectorIdWire[]; vectors: number[][] }) {
  const index = getIndex(params.indexId)
  if (params.ids.length !== params.vectors.length) {
    throw new VectorIndexInvalidVectorsError(
      `ids has ${params.ids.length} entries but vectors has ${params.vectors.length} rows`
    )
  }
  const vectors = flattenRows(params.vectors, index.dim, 'vectors')
  const ids = toNativeIds(params.ids)
  runBackend(() => index.add(vectors, ids))
  return { length: index.length }
}

export function searchVectors(params: { indexId: string; queries: number[][]; k: number }) {
  const index = getIndex(params.indexId)
  const queries = flattenRows(params.queries, index.dim, 'queries')
  const results = runBackend(() => index.search(queries, params.k))
  return { results }
}

/**
 * Removes ids one at a time, which is the only shape the backend offers. A
 * backend throw here means the handle itself is unusable, so the batch stops
 * rather than trying the rest — but ids before it are already gone, so the
 * error names how many were applied. `length` is only reported on success,
 * which is why the handle documents its own `length` as of the last call that
 * reported one.
 */
export function removeVectors(params: { indexId: string; ids: VectorIdWire[] }) {
  const index = getIndex(params.indexId)
  const removed: boolean[] = []
  for (const id of params.ids) {
    removed.push(
      runBackend(
        () => index.remove(BigInt(id)),
        (detail) =>
          `remove applied ${removed.length} of ${params.ids.length} ids before failing: ${detail}`
      )
    )
  }
  return { removed, length: index.length }
}

export function containsVectors(params: { indexId: string; ids: VectorIdWire[] }) {
  const index = getIndex(params.indexId)
  const present = params.ids.map((id) => runBackend(() => index.contains(BigInt(id))))
  return { present }
}

export async function writeVectorIndex(params: { indexId: string; path: string }) {
  const index = getIndex(params.indexId)
  const snapshotPath = resolveVectorIndexPath(params.path)
  try {
    await fsPromises.mkdir(path.dirname(snapshotPath), { recursive: true })
  } catch (error) {
    throw new VectorIndexFailedError(
      `cannot create the snapshot directory for ${snapshotPath}: ${error instanceof Error ? error.message : String(error)}`,
      error
    )
  }
  runBackend(() => index.write(snapshotPath))
  return { path: snapshotPath }
}

// Disposing an unknown id is not an error: the caller may retry after a
// worker restart, and the memory it refers to is already gone.
export function disposeVectorIndex(params: { indexId: string }) {
  const index = indexes.get(params.indexId)
  if (!index) return { disposed: false }
  // Drop the entry only once the backend confirms. Deleting first would strand
  // a failed dispose: the retry would find nothing and report success, and
  // `disposeAllVectorIndexes` could not reach it at shutdown either.
  runBackend(() => index.dispose())
  indexes.delete(params.indexId)
  return { disposed: true }
}

export function getOpenVectorIndexCount() {
  return indexes.size
}

export function disposeAllVectorIndexes() {
  for (const [indexId, index] of indexes) {
    try {
      index.dispose()
    } catch (error) {
      getEngineLogger().warn(`Failed to dispose vector index '${indexId}' during cleanup:`, error)
    }
  }
  indexes.clear()
}
