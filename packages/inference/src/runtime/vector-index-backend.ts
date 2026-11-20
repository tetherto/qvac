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
 */
export interface OpenVectorIndex {
  readonly dim: number
  readonly length: number
  readonly storage: VectorIndexStorage | undefined
  readonly calibrated: boolean | undefined
  readonly stagedSearch: boolean | undefined
  /** Null while IVF is off; undefined when the provider has no IVF search. */
  readonly ivf: VectorIndexIvfState | null | undefined
  /** Returns the setting as the native index reports it afterwards. */
  setStagedSearch(enabled: boolean): Promise<boolean>
  /** Turns IVF search on with `settings`, building its lists now, or off with null. */
  setIvf(settings: VectorIndexIvfSettings | null): Promise<VectorIndexIvfState | null>
  /** Adds `ids.length` vectors of `dim` components each, atomically. */
  add(vectors: Float32Array, ids: BigUint64Array): Promise<void>
  /**
   * One hit list per query row, ordered by descending score; never padded.
   * With built IVF state it scans the `nProbe` nearest lists, `nProbe`
   * defaulting to the setting; otherwise it scans every entry. Throws when
   * `nProbe` is given while IVF is off.
   */
  search(queries: Float32Array, k: number, nProbe: number | undefined): Promise<VectorIndexHit[][]>
  /** Answers the whole batch as one operation, so a concurrent add lands before or after it. */
  contains(ids: bigint[]): Promise<boolean[]>
  /** Returns whether the id was present. */
  remove(id: bigint): Promise<boolean>
  write(path: string): Promise<void>
  dispose(): Promise<void>
}

export interface VectorIndexBackend {
  create(dim: number, storage: VectorIndexStorage): OpenVectorIndex | Promise<OpenVectorIndex>
  load(path: string): OpenVectorIndex | Promise<OpenVectorIndex>
}
