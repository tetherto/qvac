import type { VectorIndexStorage } from '@/schemas/vector-index'

type MaybePromise<T> = T | Promise<T>

export interface TurboVecIndexSearchResult {
  scores: Float32Array
  ids: BigUint64Array
  m: number
  k: number
}

// `@qvac/turbovec-ggml` 0.7 returns a promise from every method; 0.5 and
// earlier return the value directly. Callers await either way.
export interface TurboVecIndex {
  readonly length: number
  readonly dim: number
  addWithIds(vectors: Float32Array, ids: BigUint64Array): MaybePromise<void>
  search(queries: Float32Array, k: number): MaybePromise<TurboVecIndexSearchResult>
  contains(id: bigint): MaybePromise<boolean>
  remove(id: bigint): MaybePromise<boolean>
  prepare(): MaybePromise<void>
  write(path: string): MaybePromise<void>
  dispose(): MaybePromise<void>
}

export interface TurboVecIndexProvider {
  create(options: { dim: number; storage: `${VectorIndexStorage}` }): MaybePromise<TurboVecIndex>
  load(path: string): MaybePromise<TurboVecIndex>
}
