import type { AbortSignal } from 'bare-abort-controller'
import type { VectorIndexStorage } from '@/schemas/vector-index'

type MaybePromise<T> = T | Promise<T>

export interface TurboVecCallOptions {
  signal?: AbortSignal | undefined
}

export interface TurboVecIndexSearchResult {
  scores: Float32Array
  ids: BigUint64Array
  m: number
  k: number
}

// `@qvac/turbovec-ggml` 0.7 returns a promise from every method and rejects
// with the abort reason once `signal` aborts; 0.5 and earlier return the
// value directly and ignore the options. Callers await either way.
export interface TurboVecIndex {
  readonly length: number
  readonly dim: number
  addWithIds(
    vectors: Float32Array,
    ids: BigUint64Array,
    options?: TurboVecCallOptions
  ): MaybePromise<void>
  search(
    queries: Float32Array,
    k: number,
    options?: TurboVecCallOptions
  ): MaybePromise<TurboVecIndexSearchResult>
  contains(id: bigint, options?: TurboVecCallOptions): MaybePromise<boolean>
  remove(id: bigint, options?: TurboVecCallOptions): MaybePromise<boolean>
  prepare(options?: TurboVecCallOptions): MaybePromise<void>
  write(path: string, options?: TurboVecCallOptions): MaybePromise<void>
  dispose(): MaybePromise<void>
}

export interface TurboVecIndexProvider {
  create(options: { dim: number; storage: `${VectorIndexStorage}` }): MaybePromise<TurboVecIndex>
  load(path: string): MaybePromise<TurboVecIndex>
}
