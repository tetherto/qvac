import type { AbortSignal } from 'bare-abort-controller'
import type { VectorIndexStorage } from '@/schemas/vector-index'

type MaybePromise<T> = T | Promise<T>

// `@qvac/turbovec-ggml` declares `signal` without `undefined`, so a call
// without a signal leaves the key out.
export interface TurboVecCallOptions {
  signal?: AbortSignal
}

export interface TurboVecIndexSearchResult {
  scores: Float32Array
  ids: BigUint64Array
  m: number
  k: number
}

// `@qvac/turbovec-ggml` returns a promise from every method. A read or load
// given a `signal` rejects with the abort reason once it aborts. Another
// provider may return the value directly and ignore the options. Callers
// await either way.
export interface TurboVecIndex {
  readonly length: number
  readonly dim: number
  addWithIds(vectors: Float32Array, ids: BigUint64Array): MaybePromise<void>
  search(
    queries: Float32Array,
    k: number,
    options?: TurboVecCallOptions
  ): MaybePromise<TurboVecIndexSearchResult>
  contains(id: bigint, options?: TurboVecCallOptions): MaybePromise<boolean>
  remove(id: bigint): MaybePromise<boolean>
  prepare(options?: TurboVecCallOptions): MaybePromise<void>
  write(path: string): MaybePromise<void>
  dispose(): MaybePromise<void>
}

export interface TurboVecIndexProvider {
  create(options: { dim: number; storage: `${VectorIndexStorage}` }): MaybePromise<TurboVecIndex>
  load(path: string): MaybePromise<TurboVecIndex>
}
