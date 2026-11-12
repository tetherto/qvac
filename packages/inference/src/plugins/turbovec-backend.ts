import type { TurboVecIndex } from '@qvac/rag'
import { getTurboVecIndexProvider } from '@/plugins/registry'
import {
  VECTOR_ID_RESERVED,
  VectorIndexStorage,
  type VectorIndexHit,
  type VectorIndexIvfSettings
} from '@/schemas/index'
import type { OpenVectorIndex, VectorIndexBackend } from '@/runtime/vector-index-backend'

// The native index pads short result rows with UINT64_MAX.
const PADDING_ID = BigInt(VECTOR_ID_RESERVED)

const IVF_UNSUPPORTED_MESSAGE = 'The vector index provider does not support IVF search'

type TurboVecIndexSearchResult = ReturnType<TurboVecIndex['search']>

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

function toHitRows(result: TurboVecIndexSearchResult): VectorIndexHit[][] {
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
export type IndexWithControls = TurboVecIndex & {
  readonly calibrated?: boolean
  readonly stagedSearch?: boolean
  setStagedSearch?: (enabled: boolean) => void
  buildIvf?: (nLists: number, nIter?: number) => void
  searchIvf?: (queries: Float32Array, k: number, nProbe: number) => TurboVecIndexSearchResult
}

function sameListBuild(a: VectorIndexIvfSettings, b: VectorIndexIvfSettings) {
  return a.nLists === b.nLists && (a.nIter ?? 0) === (b.nIter ?? 0)
}

function openIndex(
  index: IndexWithControls,
  storage: VectorIndexStorage | undefined
): OpenVectorIndex {
  // TurboVec precomputes rotation and codebook state on the first search
  // after a change; running it eagerly keeps that cost out of the first
  // query's latency.
  let needsPrepare = true
  function prepareOnce() {
    if (needsPrepare) {
      index.prepare()
      needsPrepare = false
    }
  }
  const ivfSupported = index.buildIvf !== undefined && index.searchIvf !== undefined
  let ivfSettings: VectorIndexIvfSettings | null = null
  let ivfBuilt = false
  function markChanged() {
    needsPrepare = true
    ivfBuilt = false
  }
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
    get ivf() {
      if (!ivfSupported) return undefined
      return ivfSettings && { ...ivfSettings, built: ivfBuilt }
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
    setIvf(settings) {
      if (!index.buildIvf || !index.searchIvf) {
        throw new Error(IVF_UNSUPPORTED_MESSAGE)
      }
      if (settings === null) {
        ivfSettings = null
        ivfBuilt = false
        return null
      }
      const listsCurrent = ivfBuilt && ivfSettings !== null && sameListBuild(ivfSettings, settings)
      if (!listsCurrent) {
        // Mark the lists stale before building. If the build throws, search
        // scans every entry instead of probing lists the native index may
        // already have dropped.
        ivfBuilt = false
        index.buildIvf(settings.nLists, settings.nIter ?? 0)
        ivfBuilt = true
      }
      ivfSettings = settings
      return { ...ivfSettings, built: ivfBuilt }
    },
    add(vectors, ids) {
      index.addWithIds(vectors, ids)
      markChanged()
    },
    search(queries, k, nProbe) {
      if (nProbe !== undefined && ivfSettings === null) {
        throw new Error(
          ivfSupported
            ? 'nProbe applies only to IVF search; call setIvf() first'
            : IVF_UNSUPPORTED_MESSAGE
        )
      }
      prepareOnce()
      if (ivfSettings && ivfBuilt && index.searchIvf) {
        return toHitRows(index.searchIvf(queries, k, nProbe ?? ivfSettings.nProbe))
      }
      return toHitRows(index.search(queries, k))
    },
    contains(id) {
      return index.contains(id)
    },
    remove(id) {
      const removed = index.remove(id)
      if (removed) markChanged()
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
