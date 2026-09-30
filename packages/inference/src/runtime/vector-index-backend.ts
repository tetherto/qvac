import type { VectorIndexHit, VectorIndexStorage } from '@/schemas/index'

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
  /** Adds `ids.length` vectors of `dim` components each, atomically. */
  add(vectors: Float32Array, ids: BigUint64Array): void
  /** One hit list per query row, ordered by descending score; never padded. */
  search(queries: Float32Array, k: number): VectorIndexHit[][]
  contains(id: bigint): boolean
  /** Returns whether the id was present. */
  remove(id: bigint): boolean
  write(path: string): void
  dispose(): void
}

export interface VectorIndexBackend {
  create(dim: number, storage: VectorIndexStorage): OpenVectorIndex
  load(path: string): OpenVectorIndex
}
