import type { IndexFallbackReason, IndexStorage } from '../types.js'

// The subset of `@qvac/turbovec-ggml`'s IdMapIndex this package uses. The
// addon is an optional peer, so its own types are not part of ours.
// An index runs its calls in call order; `length` counts finished calls only.

export interface NativeSearchResult {
  scores: Float32Array
  ids: BigUint64Array
  k: number
}

export interface NativeIndex {
  readonly length: number
  readonly dim: number
  readonly bitWidth: number
  addWithIds(vectors: Float32Array, ids: BigUint64Array): Promise<void>
  remove(id: bigint): Promise<boolean>
  compact(): Promise<void>
  contains(id: bigint): Promise<boolean>
  search(
    queries: Float32Array,
    k: number,
    options?: { signal?: AbortSignal }
  ): Promise<NativeSearchResult>
  searchFiltered(
    queries: Float32Array,
    k: number,
    allowedIds: BigUint64Array,
    options?: { signal?: AbortSignal }
  ): Promise<NativeSearchResult>
  prepare(): Promise<void>
  write(path: string): Promise<void>
  dispose(): Promise<void>
}

export interface NativeIndexModule {
  create(dim: number, storage: IndexStorage): NativeIndex
  load(path: string): Promise<NativeIndex>
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
  load(path: string): Promise<NativeIndex>
}

export type NativeIndexLoad =
  | { module: NativeIndexModule }
  | { module: null; reason: Extract<IndexFallbackReason, `addon-${string}`>; error?: unknown }

type Loader = () => Promise<NativeIndexModule | null>

let loading: Promise<NativeIndexLoad> | null = null
let loader: Loader = importTurboVec

// Resolves without a module when the addon is not installed or cannot load on
// this runtime; search then scans HyperDB instead. The result is cached, so a
// host that seals addon loading must let `ready()` run this first.
export function loadNativeIndex(): Promise<NativeIndexLoad> {
  if (!loading) {
    loading = loader().then(
      (module): NativeIndexLoad =>
        module ? { module } : { module: null, reason: 'addon-missing' },
      (error: unknown): NativeIndexLoad =>
        isMissing(error)
          ? { module: null, reason: 'addon-missing' }
          : { module: null, reason: 'addon-load-failed', error }
    )
  }
  return loading
}

// Tests swap the loader to compare against the scan path.
export function setNativeIndexLoader(next: Loader | null): void {
  loader = next ?? importTurboVec
  loading = null
}

function isMissing(error: unknown): boolean {
  const { code, specifier } = (error ?? {}) as { code?: unknown; specifier?: unknown }
  return code === 'MODULE_NOT_FOUND' && specifier === '@qvac/turbovec-ggml'
}

async function importTurboVec(): Promise<NativeIndexModule | null> {
  // The binding only loads under Bare.
  if ((globalThis as { Bare?: unknown }).Bare === undefined) return null
  const imported = (await import('@qvac/turbovec-ggml')) as unknown as {
    default?: IdMapIndexClass
  }
  const IdMapIndex = imported.default
  if (typeof IdMapIndex !== 'function') return null
  // The package imports anywhere but loads its native binding on first use,
  // which fails on hosts without a prebuild. Releases before 0.7 are
  // synchronous and fall back to the scan.
  const disposed: unknown = new IdMapIndex({ dim: 8, storage: 'q8' }).dispose()
  if (!(disposed instanceof Promise)) return null
  await disposed
  return {
    create: (dim, storage) => new IdMapIndex({ dim, storage }),
    load: (path) => IdMapIndex.load(path)
  }
}
