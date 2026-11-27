import type {
  IndexFallbackReason,
  IndexHandle,
  IndexProvider,
  IndexSearchResult,
  IndexStorage
} from '../types.js'
import { importers } from './imports.js'

// `@qvac/turbovec-ggml` is the default provider. The addon is an optional
// peer, so its own types are not part of ours.
export type NativeIndex = IndexHandle
export type NativeIndexModule = IndexProvider
export type NativeSearchResult = IndexSearchResult

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
  new (options: { dim: number; storage: IndexStorage }): IndexHandle
  load(path: string): Promise<IndexHandle>
}

export type NativeIndexLoad =
  | { module: NativeIndexModule }
  | { module: null; reason: Extract<IndexFallbackReason, `addon-${string}`>; error?: unknown }

let loading: Promise<NativeIndexLoad> | null = null

// Resolves without a module when the addon is not installed or cannot load on
// this runtime; search then scans HyperDB instead. The result is cached, so a
// host that seals addon loading must let `ready()` run this first.
export function loadNativeIndex(): Promise<NativeIndexLoad> {
  loading ??= settleNativeIndex(importTurboVec())
  return loading
}

// Forgets the cached import, so the next `ready()` runs `importers.turbovec` again.
export function forgetNativeIndex(): void {
  loading = null
}

function settleNativeIndex(importing: Promise<IndexProvider | null>): Promise<NativeIndexLoad> {
  return importing.then(
    (module): NativeIndexLoad => (module ? { module } : { module: null, reason: 'addon-missing' }),
    (error: unknown): NativeIndexLoad =>
      isMissing(error)
        ? { module: null, reason: 'addon-missing' }
        : { module: null, reason: 'addon-load-failed', error }
  )
}

function isMissing(error: unknown): boolean {
  const { code, specifier } = (error ?? {}) as { code?: unknown; specifier?: unknown }
  return code === 'MODULE_NOT_FOUND' && specifier === '@qvac/turbovec-ggml'
}

async function importTurboVec(): Promise<IndexProvider | null> {
  // The binding only loads under Bare.
  if ((globalThis as { Bare?: unknown }).Bare === undefined) return null
  const imported = (await importers.turbovec()) as { default?: IdMapIndexClass }
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
