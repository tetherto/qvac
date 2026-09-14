import type { TurboVecIndex } from '@qvac/rag'
import { getTurboVecIndexProvider } from '@/plugins/registry'
import {
  readVectorIndexStorage,
  VECTOR_ID_RESERVED,
  type VectorIndexHit,
  type VectorIndexStorage
} from '@/schemas/index'
import type { OpenVectorIndex, VectorIndexBackend } from '@/runtime/vector-index-backend'

// The native index pads short result rows with UINT64_MAX.
const PADDING_ID = BigInt(VECTOR_ID_RESERVED)

function toHitRows(result: ReturnType<TurboVecIndex['search']>): VectorIndexHit[][] {
  const rows: VectorIndexHit[][] = []
  for (let row = 0; row < result.m; row++) {
    const hits: VectorIndexHit[] = []
    for (let slot = 0; slot < result.k; slot++) {
      const offset = row * result.k + slot
      const id = result.ids[offset]
      if (id === undefined || id === PADDING_ID) break
      hits.push({ id: id.toString(), score: result.scores[offset] ?? 0 })
    }
    rows.push(hits)
  }
  return rows
}

function openIndex(index: TurboVecIndex, storage: VectorIndexStorage | undefined): OpenVectorIndex {
  // TurboVec precomputes rotation and codebook state on the first search
  // after a change; running it eagerly keeps that cost out of the first
  // query's latency.
  let needsPrepare = true
  return {
    get dim() {
      return index.dim
    },
    get length() {
      return index.length
    },
    storage,
    add(vectors, ids) {
      index.addWithIds(vectors, ids)
      needsPrepare = true
    },
    search(queries, k) {
      if (needsPrepare) {
        index.prepare()
        needsPrepare = false
      }
      return toHitRows(index.search(queries, k))
    },
    contains(id) {
      return index.contains(id)
    },
    remove(id) {
      const removed = index.remove(id)
      if (removed) needsPrepare = true
      return removed
    },
    write(path) {
      index.write(path)
    },
    dispose() {
      index.dispose()
    }
  }
}

/**
 * The vector index feature's only backend: the fabric vector index that the
 * embedding plugin exposes through the `turbovecIndexProvider` capability.
 * It serves every `VectorIndexStorage` mode; the two TurboVec modes add the
 * dimension rule (multiple of 8, at most 1024), which the native index
 * enforces itself. A loaded snapshot reports its storage mode only when the
 * native object exposes one; older addon builds do not.
 */
export function getTurboVecBackend(): VectorIndexBackend | undefined {
  const provider = getTurboVecIndexProvider()
  if (!provider) return undefined
  return {
    create(dim, storage) {
      return openIndex(provider.create({ dim, storage }), storage)
    },
    load(path) {
      const index = provider.load(path)
      return openIndex(index, readVectorIndexStorage((index as { storage?: unknown }).storage))
    }
  }
}
