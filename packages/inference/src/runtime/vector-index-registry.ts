import type { AbortSignal } from 'bare-abort-controller'
import { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import { QvacErrorBase } from '@qvac/error'
import { getTurboVecBackend } from '@/plugins/turbovec-backend'
import type {
  OpenVectorIndex,
  VectorIndexBackend,
  VectorIndexState
} from '@/runtime/vector-index-backend'
import { getConfiguredCacheDir } from '@/runtime/state'
import { generateRandomRequestId } from '@/runtime/request-id'
import { resolveSessionId } from '@/runtime/session-id'
import { getEngineLogger } from '@/logging/index'
import type { VectorIdWire, VectorIndexIvfSettings, VectorIndexStorage } from '@/schemas/index'
import {
  VectorIndexFailedError,
  VectorIndexInvalidVectorsError,
  VectorIndexNotFoundError,
  VectorIndexProviderUnavailableError
} from '@/errors/index'

// Worker-side bookkeeping for open indexes: ids, wire-to-native conversion,
// row validation, snapshot paths, and lifetime. Engine behaviour lives in
// the backend. Each index records the session that opened it, so closing that
// session can release it.
interface TrackedIndex {
  index: OpenVectorIndex
  sessionId: string
}

const indexes = new Map<string, TrackedIndex>()
const pendingIndexes = new Set<Promise<unknown>>()

function requireBackend(): VectorIndexBackend {
  const backend = getTurboVecBackend()
  if (!backend) throw new VectorIndexProviderUnavailableError()
  return backend
}

function getIndex(indexId: string): OpenVectorIndex {
  const tracked = indexes.get(indexId)
  if (!tracked) throw new VectorIndexNotFoundError(indexId)
  return tracked.index
}

// Backends throw plain TypeError/RangeError/Error values from the native
// layer; wrap them so the caller receives a coded error with the original
// message preserved as cause. `describe` adds caller context to the message
// and is evaluated at throw time, so it can report progress made so far. A
// rejection with the abort reason of `signal` passes through unwrapped, so the
// handler can tell a cancel from a native failure.
async function runBackend<T>(
  action: () => Promise<T>,
  signal?: AbortSignal,
  describe?: (detail: string) => string
): Promise<T> {
  try {
    return await action()
  } catch (error) {
    failBackend(error, signal, describe)
  }
}

function failBackend(
  error: unknown,
  signal: AbortSignal | undefined,
  describe?: (detail: string) => string
): never {
  if (error instanceof QvacErrorBase) throw error
  if (signal?.aborted && error === signal.reason) throw error
  const detail = error instanceof Error ? error.message : String(error)
  throw new VectorIndexFailedError(describe ? describe(detail) : detail, error)
}

// Shutdown waits for pending opens to register or finish cleanup. After a
// cancelled load, dispose the index when it opens. If disposal fails, keep
// the index registered so shutdown can retry.
function openVectorIndex(
  sessionId: string,
  action: () => OpenVectorIndex | Promise<OpenVectorIndex>,
  signal?: AbortSignal
): Promise<{ index: OpenVectorIndex; indexId: string }> {
  const opening = (async () => {
    try {
      return await action()
    } catch (error) {
      failBackend(error, undefined)
    }
  })()
  return new Promise((resolve, reject) => {
    let abandoned = false
    const onAbort = () => {
      abandoned = true
      reject(signal?.reason)
    }
    const settled = opening.then(
      async (index) => {
        if (abandoned) {
          try {
            await index.dispose()
          } catch (error) {
            track(index, sessionId)
            getEngineLogger().warn('Failed to dispose a vector index opened after a cancel:', error)
          }
          return
        }
        signal?.removeEventListener('abort', onAbort)
        resolve({ index, indexId: track(index, sessionId) })
      },
      (error: unknown) => {
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
    pendingIndexes.add(settled)
    void settled.then(() => pendingIndexes.delete(settled))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Snapshot paths are used as given when absolute. A relative path resolves
 * against the QVAC data directory (the parent of the configured cache
 * directory), so the same relative path works on every platform.
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

function track(index: OpenVectorIndex, sessionId: string) {
  const indexId = generateRandomRequestId()
  indexes.set(indexId, { index, sessionId })
  return indexId
}

// Omit a control the provider lacks so clients read it as unknown, not off.
function indexState(index: VectorIndexState) {
  const { ivf } = index
  return {
    ...(index.calibrated !== undefined && { calibrated: index.calibrated }),
    ...(index.stagedSearch !== undefined && { stagedSearch: index.stagedSearch }),
    ...(ivf !== undefined && { ivf })
  }
}

export async function createVectorIndex(params: {
  dim: number
  storage: VectorIndexStorage
  sessionId?: string | undefined
}) {
  const backend = requireBackend()
  const { index, indexId } = await openVectorIndex(resolveSessionId(params), () =>
    backend.create(params.dim, params.storage)
  )
  return {
    indexId,
    dim: index.dim,
    storage: params.storage,
    length: index.length,
    ...indexState(index)
  }
}

export async function loadVectorIndex(
  params: { path: string; sessionId?: string | undefined },
  signal?: AbortSignal
) {
  const backend = requireBackend()
  const { index, indexId } = await openVectorIndex(
    resolveSessionId(params),
    () => backend.load(resolveVectorIndexPath(params.path)),
    signal
  )
  return {
    indexId,
    dim: index.dim,
    length: index.length,
    ...indexState(index),
    ...(index.storage !== undefined && { storage: index.storage })
  }
}

export async function addVectors(
  params: { indexId: string; ids: VectorIdWire[]; vectors: number[][] },
  signal?: AbortSignal
) {
  const index = getIndex(params.indexId)
  if (params.ids.length !== params.vectors.length) {
    throw new VectorIndexInvalidVectorsError(
      `ids has ${params.ids.length} entries but vectors has ${params.vectors.length} rows`
    )
  }
  const vectors = flattenRows(params.vectors, index.dim, 'vectors')
  const ids = toNativeIds(params.ids)
  const state = await runBackend(() => index.add(vectors, ids, signal), signal)
  return { length: state.length, ...indexState(state) }
}

export async function setVectorIndexStagedSearch(
  params: { indexId: string; enabled: boolean },
  signal?: AbortSignal
) {
  const index = getIndex(params.indexId)
  return {
    stagedSearch: await runBackend(() => index.setStagedSearch(params.enabled, signal), signal)
  }
}

export async function setVectorIndexIvf(
  params: { indexId: string; ivf: VectorIndexIvfSettings | null },
  signal?: AbortSignal
) {
  const index = getIndex(params.indexId)
  return { ivf: await runBackend(() => index.setIvf(params.ivf, signal), signal) }
}

export async function searchVectors(
  params: {
    indexId: string
    queries: number[][]
    k: number
    nProbe?: number | undefined
  },
  signal?: AbortSignal
) {
  const index = getIndex(params.indexId)
  const queries = flattenRows(params.queries, index.dim, 'queries')
  const results = await runBackend(
    () => index.search(queries, params.k, params.nProbe, signal),
    signal
  )
  return { results }
}

/**
 * The backend removes the batch as one operation, so no other call on the
 * index lands between two of its ids. A backend throw means the handle itself
 * is unusable, so the batch stops rather than trying the rest — but ids before
 * it are already gone, so the error names how many were applied. `length` is only reported on success,
 * which is why the handle documents its own `length` as of the last call that
 * reported one.
 */
export async function removeVectors(
  params: { indexId: string; ids: VectorIdWire[] },
  signal?: AbortSignal
) {
  const index = getIndex(params.indexId)
  const removed: boolean[] = []
  const state = await runBackend(
    () =>
      index.remove(
        params.ids.map((id) => BigInt(id)),
        removed,
        signal
      ),
    signal,
    (detail) =>
      `remove applied ${removed.length} of ${params.ids.length} ids before failing: ${detail}`
  )
  return { removed, length: state.length, ...indexState(state) }
}

export async function containsVectors(
  params: { indexId: string; ids: VectorIdWire[] },
  signal?: AbortSignal
) {
  const index = getIndex(params.indexId)
  const present = await runBackend(
    () =>
      index.contains(
        params.ids.map((id) => BigInt(id)),
        signal
      ),
    signal
  )
  return { present }
}

export async function writeVectorIndex(
  params: { indexId: string; path: string },
  signal?: AbortSignal
) {
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
  await runBackend(() => index.write(snapshotPath, signal), signal)
  return { path: snapshotPath }
}

// Disposing an unknown id is not an error: the caller may retry after a
// worker restart, and the memory it refers to is already gone.
export async function disposeVectorIndex(params: { indexId: string }) {
  const tracked = indexes.get(params.indexId)
  if (!tracked) return { disposed: false }
  // Drop the entry only once the backend confirms. Deleting first would strand
  // a failed dispose: the retry would find nothing and report success, and
  // `disposeAllVectorIndexes` could not reach it at shutdown either.
  await runBackend(() => tracked.index.dispose())
  indexes.delete(params.indexId)
  return { disposed: true }
}

export function getOpenVectorIndexCount() {
  return indexes.size
}

/**
 * Releases the indexes a session opened. Once the session ends its handles
 * can no longer reach the worker, so nothing else would release them before
 * shutdown. An index whose dispose fails stays registered and is released at
 * shutdown. Returns the ids released.
 */
export async function disposeSessionVectorIndexes(sessionId: string): Promise<string[]> {
  const released: string[] = []
  for (const [indexId, tracked] of indexes) {
    if (tracked.sessionId !== sessionId) continue
    try {
      await tracked.index.dispose()
      indexes.delete(indexId)
      released.push(indexId)
    } catch (error) {
      getEngineLogger().warn(
        `Failed to dispose vector index '${indexId}' of closed session '${sessionId}':`,
        error
      )
    }
  }
  return released
}

export async function disposeAllVectorIndexes() {
  await Promise.allSettled(pendingIndexes)
  for (const [indexId, { index }] of indexes) {
    try {
      await index.dispose()
    } catch (error) {
      getEngineLogger().warn(`Failed to dispose vector index '${indexId}' during cleanup:`, error)
    }
  }
  indexes.clear()
}
