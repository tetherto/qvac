import type { AbortSignal } from 'bare-abort-controller'
import type {
  VectorIndexHit,
  VectorIndexIvfSettings,
  VectorIndexIvfState,
  VectorIndexStorage
} from '@/schemas/index'

/**
 * An open index as the vector index feature sees it. Row-major vectors and
 * unsigned 64-bit ids go in; finished hit rows come out. Anything specific
 * to a native engine (warm-up, result padding, how the storage mode is
 * reported) is handled by the backend that implements this, not by callers.
 * Calls on one index run in call order. A queued call skips native work when
 * its signal aborts. An active read can reject before native work ends if the
 * provider supports cancellation; an active mutation runs to the end and
 * reports its result.
 */
export interface VectorIndexState {
  readonly length: number
  readonly calibrated: boolean | undefined
  readonly stagedSearch: boolean | undefined
  /** Null while IVF is off; undefined when the provider has no IVF search. */
  readonly ivf: VectorIndexIvfState | null | undefined
}

export interface OpenVectorIndex extends VectorIndexState {
  readonly dim: number
  readonly storage: VectorIndexStorage | undefined
  /** Returns the setting as the native index reports it afterwards. */
  setStagedSearch(enabled: boolean, signal?: AbortSignal): Promise<boolean>
  /** Turns IVF search on with `settings`, building its lists now, or off with null. */
  setIvf(
    settings: VectorIndexIvfSettings | null,
    signal?: AbortSignal
  ): Promise<VectorIndexIvfState | null>
  /**
   * Adds `ids.length` vectors of `dim` components each, atomically. The state
   * is read in the same operation, so a dispose queued behind it cannot fail it.
   */
  add(vectors: Float32Array, ids: BigUint64Array, signal?: AbortSignal): Promise<VectorIndexState>
  /**
   * One hit list per query row, ordered by descending score; never padded.
   * With built IVF state it scans the `nProbe` nearest lists, `nProbe`
   * defaulting to the setting; otherwise it scans every entry. Throws when
   * `nProbe` is given while IVF is off.
   */
  search(
    queries: Float32Array,
    k: number,
    nProbe: number | undefined,
    signal?: AbortSignal
  ): Promise<VectorIndexHit[][]>
  /** Answers the whole batch as one operation, so a concurrent add lands before or after it. */
  contains(ids: bigint[], signal?: AbortSignal): Promise<boolean[]>
  /**
   * Removes the ids in order as one operation, appending whether each was
   * present to `removed`, so a failure part-way leaves the applied count there.
   */
  remove(ids: bigint[], removed: boolean[], signal?: AbortSignal): Promise<VectorIndexState>
  write(path: string, signal?: AbortSignal): Promise<void>
  /** Waits for calls already made on the index, then frees it. */
  dispose(): Promise<void>
}

export interface VectorIndexBackend {
  create(dim: number, storage: VectorIndexStorage): OpenVectorIndex | Promise<OpenVectorIndex>
  load(path: string): OpenVectorIndex | Promise<OpenVectorIndex>
}
