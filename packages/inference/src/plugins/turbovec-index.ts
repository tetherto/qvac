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

// Providers may return values or promises. Those that honor `signal`
// reject with the signal's abort reason.
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
