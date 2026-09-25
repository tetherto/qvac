/**
 * The shape of the shared resource table, and how a client resolves it.
 *
 * The table is data so that two clients in different languages can agree on
 * what `useModel: { deps: ['whisper'] }` means. The two things a client must
 * supply are the two things data cannot carry: the descriptor behind a model
 * constant, and where a bundled fixture lives on this platform.
 */

/** An SDK model constant, named rather than inlined. */
export interface ConstRef {
  $const: string
}

/** A bundled fixture: a filesystem path here, a bundled-asset URI there. */
export interface AssetRef {
  $asset: { kind: string; file: string }
}

export type ResourceValue = ConstRef | AssetRef | ResourceValue[] | { [key: string]: unknown }

export interface ResourceEntry {
  /** Platforms that define this key. Absent means every platform. */
  on?: string[]
  constant?: ConstRef
  modelSrc?: string
  type?: string
  config?: Record<string, unknown>
  /**
   * Skip this entry when pre-downloading. Bundled addons have no model to
   * fetch, and a few entries are deliberately loaded cold by their tests.
   */
  skipPreDownload?: boolean
}

export type ResourceTable = Record<string, ResourceEntry>

/**
 * Replace `$const` and `$asset` placeholders with what this client resolves
 * them to, leaving everything else exactly as written.
 *
 * Recursive because the placeholders are nested: a companion model sits inside
 * `config`, sometimes inside an object inside `config`.
 */
export function resolveResourceValue(
  value: unknown,
  resolveConst: (name: string) => unknown,
  resolveAsset: (kind: string, file: string) => unknown
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => resolveResourceValue(entry, resolveConst, resolveAsset))
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.$const === 'string') return resolveConst(record.$const)
    if (record.$asset && typeof record.$asset === 'object') {
      const { kind, file } = record.$asset as { kind: string; file: string }
      return resolveAsset(kind, file)
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [
        key,
        resolveResourceValue(entry, resolveConst, resolveAsset)
      ])
    )
  }
  return value
}

/**
 * Register every table entry this platform defines.
 *
 * Replaces the hand-written `resources.define(...)` runs the three consumer
 * entries each kept their own copy of.
 */
export function applyResourceTable(
  table: ResourceTable,
  platform: string,
  define: (dep: string, definition: Record<string, unknown>) => void,
  resolveConst: (name: string) => unknown,
  resolveAsset: (kind: string, file: string) => unknown
): void {
  for (const [dep, entry] of Object.entries(table)) {
    if (entry.on && !entry.on.includes(platform)) continue
    const { on: _on, ...rest } = entry
    define(dep, resolveResourceValue(rest, resolveConst, resolveAsset) as Record<string, unknown>)
  }
}
