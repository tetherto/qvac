import type { AbortSignal } from 'bare-abort-controller'
import type {
  TurboVecCallOptions,
  TurboVecIndex,
  TurboVecIndexSearchResult
} from '@/plugins/turbovec-index'
import { getTurboVecIndexProvider } from '@/plugins/registry'
import { untilSettledOrAborted } from '@/runtime/model-work-lock'
import {
  VECTOR_ID_RESERVED,
  VectorIndexStorage,
  type VectorIndexHit,
  type VectorIndexIvfSettings
} from '@/schemas/index'
import type {
  OpenVectorIndex,
  VectorIndexBackend,
  VectorIndexState
} from '@/runtime/vector-index-backend'

// The native index pads short result rows with UINT64_MAX.
const PADDING_ID = BigInt(VECTOR_ID_RESERVED)

const IVF_UNSUPPORTED_MESSAGE = 'The vector index provider does not support IVF search'

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
  setStagedSearch?: (enabled: boolean, options?: TurboVecCallOptions) => void | Promise<void>
  buildIvf?: (nLists: number, nIter?: number, options?: TurboVecCallOptions) => void | Promise<void>
  searchIvf?: (
    queries: Float32Array,
    k: number,
    nProbe: number,
    options?: TurboVecCallOptions
  ) => TurboVecIndexSearchResult | Promise<TurboVecIndexSearchResult>
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
  async function prepareOnce(signal: AbortSignal | undefined) {
    if (needsPrepare) {
      needsPrepare = false
      try {
        await index.prepare({ signal })
      } catch (error) {
        needsPrepare = true
        throw error
      }
    }
  }
  const ivfSupported = index.buildIvf !== undefined && index.searchIvf !== undefined
  let ivfSettings: VectorIndexIvfSettings | null = null
  let ivfBuilt = false
  function markChanged() {
    needsPrepare = true
    ivfBuilt = false
  }
  function ivfState() {
    if (!ivfSupported) return undefined
    return ivfSettings && { ...ivfSettings, built: ivfBuilt }
  }
  // The native getters throw once the index is disposed, so callers read the
  // state inside the operation that changed it.
  function state(): VectorIndexState {
    return {
      length: index.length,
      calibrated: index.calibrated,
      stagedSearch: index.stagedSearch,
      ivf: ivfState()
    }
  }
  // One call at a time per index: each one reads and updates the prepare and
  // IVF flags around its native await, and an interleaved add or remove would
  // leave IVF marked built over lists the native index has dropped. A call
  // whose signal aborts while it waits leaves the queue without running.
  let tail: Promise<unknown> = Promise.resolve()
  function exclusive<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    const previous = tail
    const waited = signal ? untilSettledOrAborted(previous, signal) : previous
    const result = waited.then(() => {
      signal?.throwIfAborted()
      return run()
    })
    // An aborted call settles before the calls ahead of it, so the next call
    // still waits for those.
    tail = Promise.all([previous, result.catch(() => {})])
    return result
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
      return ivfState()
    },
    setStagedSearch: (enabled, signal) =>
      exclusive(signal, async () => {
        // Without the getter the setting could not be confirmed, so a provider
        // needs both halves of the control.
        if (!index.setStagedSearch || typeof index.stagedSearch !== 'boolean') {
          throw new Error('The vector index provider does not support staged search controls')
        }
        await index.setStagedSearch(enabled, { signal })
        return index.stagedSearch
      }),
    setIvf: (settings, signal) =>
      exclusive(signal, async () => {
        if (!index.buildIvf || !index.searchIvf) {
          throw new Error(IVF_UNSUPPORTED_MESSAGE)
        }
        if (settings === null) {
          ivfSettings = null
          ivfBuilt = false
          return null
        }
        const listsCurrent =
          ivfBuilt && ivfSettings !== null && sameListBuild(ivfSettings, settings)
        if (!listsCurrent) {
          // Mark the lists stale before building. If the build throws or is
          // aborted, search scans every entry instead of probing lists the
          // native index may already have dropped.
          ivfBuilt = false
          await index.buildIvf(settings.nLists, settings.nIter ?? 0, { signal })
          ivfBuilt = true
        }
        ivfSettings = settings
        return { ...ivfSettings, built: ivfBuilt }
      }),
    add: (vectors, ids, signal) =>
      exclusive(signal, async () => {
        markChanged()
        await index.addWithIds(vectors, ids, { signal })
        return state()
      }),
    search: (queries, k, nProbe, signal) =>
      exclusive(signal, async () => {
        if (nProbe !== undefined && ivfSettings === null) {
          throw new Error(
            ivfSupported
              ? 'nProbe applies only to IVF search; call setIvf() first'
              : IVF_UNSUPPORTED_MESSAGE
          )
        }
        await prepareOnce(signal)
        if (ivfSettings && ivfBuilt && index.searchIvf) {
          return toHitRows(
            await index.searchIvf(queries, k, nProbe ?? ivfSettings.nProbe, { signal })
          )
        }
        return toHitRows(await index.search(queries, k, { signal }))
      }),
    contains: (ids, signal) =>
      exclusive(signal, async () => {
        const present: boolean[] = []
        for (const id of ids) present.push(await index.contains(id, { signal }))
        return present
      }),
    remove: (ids, removed, signal) =>
      exclusive(signal, async () => {
        try {
          for (const id of ids) {
            const present = await index.remove(id, { signal })
            if (present) markChanged()
            removed.push(present)
            signal?.throwIfAborted()
          }
        } catch (error) {
          // An aborted call rejects at once while the native removal runs on,
          // so the id may be gone.
          if (signal?.aborted) markChanged()
          throw error
        }
        return state()
      }),
    write: (path, signal) => exclusive(signal, async () => await index.write(path, { signal })),
    dispose: () => exclusive(undefined, async () => await index.dispose())
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
    async load(path, signal) {
      const index = await provider.load(path, { signal })
      return openIndex(index, storageFromBitWidth((index as { bitWidth?: unknown }).bitWidth))
    }
  }
}
