import type { IndexStorage } from '../types.js'

// The subset of `@qvac/turbovec-ggml`'s IdMapIndex this package uses. The
// addon is an optional peer, so its own types are not part of ours.
export interface NativeSearchResult {
  scores: Float32Array
  ids: BigUint64Array
  k: number
}

export interface NativeFilter {
  search(queries: Float32Array, k: number): NativeSearchResult
  dispose(): void
}

export interface NativeIndex {
  readonly length: number
  readonly dim: number
  readonly bitWidth: number
  addWithIds(vectors: Float32Array, ids: BigUint64Array): void
  remove(id: bigint): boolean
  contains(id: bigint): boolean
  search(queries: Float32Array, k: number): NativeSearchResult
  searchFiltered(queries: Float32Array, k: number, allowedIds: BigUint64Array): NativeSearchResult
  prepareFilter(allowedIds: BigUint64Array): NativeFilter
  prepare(): void
  write(path: string): void
  dispose(): void
}

export interface NativeIndexModule {
  create(dim: number, storage: IndexStorage): NativeIndex
  load(path: string): NativeIndex
}

// UINT64_MAX pads short result rows.
export const PADDING_ID = 0xffffffffffffffffn

// TurboVec quantization rejects vector and query components at or above this.
export const TURBOVEC_MAX_COMPONENT = 1e16

export const BIT_WIDTHS: Record<IndexStorage, number> = {
  f32: 32,
  q8: 8,
  'turbovec-q4': 4,
  'turbovec-q2': 2
}

interface IdMapIndexClass {
  new (options: { dim: number; storage: IndexStorage }): NativeIndex
  load(path: string): NativeIndex
}

type Loader = () => Promise<NativeIndexModule | null>

let loading: Promise<NativeIndexModule | null> | null = null
let loader: Loader = importTurboVec

// Resolves to null when the addon is not installed or cannot load on this
// runtime; search then scans HyperDB instead.
export function loadNativeIndex(): Promise<NativeIndexModule | null> {
  if (!loading) loading = loader().catch(() => null)
  return loading
}

// Tests swap the loader to compare against the scan path.
export function setNativeIndexLoader(next: Loader | null): void {
  loader = next ?? importTurboVec
  loading = null
}

async function importTurboVec(): Promise<NativeIndexModule | null> {
  const imported = (await import('@qvac/turbovec-ggml')) as unknown as {
    default?: IdMapIndexClass
  }
  const IdMapIndex = imported.default
  if (typeof IdMapIndex !== 'function') return null
  // The package imports anywhere but loads its native binding on first use,
  // which fails on Node and on hosts without a prebuild.
  new IdMapIndex({ dim: 8, storage: 'q8' }).dispose()
  return {
    create: (dim, storage) => new IdMapIndex({ dim, storage }),
    load: (path) => IdMapIndex.load(path)
  }
}
