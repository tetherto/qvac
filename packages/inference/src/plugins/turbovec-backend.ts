import type { TurboVecIndex } from '@qvac/rag'
import { getTurboVecIndexProvider } from '@/plugins/registry'
import { VECTOR_ID_RESERVED, VectorIndexStorage, type VectorIndexHit } from '@/schemas/index'
import type { OpenVectorIndex, VectorIndexBackend } from '@/runtime/vector-index-backend'

// The native index pads short result rows with UINT64_MAX.
const PADDING_ID = BigInt(VECTOR_ID_RESERVED)

/**
 * The native index reports only its effective bit width after a load. Three
 * widths map to one storage mode each; 4 bits is either `q4` or
 * `turbovec-q4`, which the snapshot header distinguishes but the addon does
 * not expose yet, so those loads report no storage mode.
 */
export function storageFromBitWidth(bitWidth: unknown): VectorIndexStorage | undefined {
  switch (bitWidth) {
    case 32:
      return VectorIndexStorage.F32
    case 8:
      return VectorIndexStorage.Q8
    case 2:
      return VectorIndexStorage.TURBOVEC_Q2
    default:
      return undefined
  }
}

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

// The native index exposes these beyond the TurboVecIndex interface, which
// does not declare them; a provider that predates them leaves them out.
type IndexWithControls = TurboVecIndex & {
  readonly calibrated?: boolean
  readonly stagedSearch?: boolean
  setStagedSearch?: (enabled: boolean) => void
}

function openIndex(
  index: IndexWithControls,
  storage: VectorIndexStorage | undefined
): OpenVectorIndex {
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
    get calibrated() {
      return index.calibrated
    },
    get stagedSearch() {
      return index.stagedSearch
    },
    setStagedSearch(enabled) {
      // Without the getter the setting could not be confirmed, so a provider
      // needs both halves of the control.
      if (!index.setStagedSearch || typeof index.stagedSearch !== 'boolean') {
        throw new Error('The vector index provider does not support staged search controls')
      }
      index.setStagedSearch(enabled)
      return index.stagedSearch
    },
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
 * dimension rule (multiple of 8, at most 16384), which the native index
 * enforces itself.
 */
export function getTurboVecBackend(): VectorIndexBackend | undefined {
  const provider = getTurboVecIndexProvider()
  if (!provider) return undefined
  return {
    async create(dim, storage) {
      return openIndex(await provider.create({ dim, storage }), storage)
    },
    async load(path) {
      const index = await provider.load(path)
      return openIndex(index, storageFromBitWidth((index as { bitWidth?: unknown }).bitWidth))
    }
  }
}
