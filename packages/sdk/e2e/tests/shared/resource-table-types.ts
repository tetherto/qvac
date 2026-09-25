/** The shape of the shared resource table, and how a client resolves it. */

/** An SDK model constant, named rather than inlined. */
export interface ConstRef {
  $const: string
}

/** A bundled fixture: a filesystem path here, a bundled-asset URI there. */
export interface AssetRef {
  $asset: { kind: string; file: string }
}

/** A data file shipped inside a package, named rather than pathed. */
export interface PackageAssetRef {
  $packageAsset: { package: string; file: string }
}

export type ResourceValue =
  ConstRef | AssetRef | PackageAssetRef | ResourceValue[] | { [key: string]: unknown }

export interface ResourceEntry {
  /** Platforms that define this key. Absent means every platform. */
  on?: string[]
  constant?: ConstRef
  modelSrc?: string
  type?: string
  config?: Record<string, unknown>
  /**
   * Config keys that differ by platform, merged over `config`. Keeping these in the table is what
   * stops a consumer entry from redefining the resource.
   */
  configOn?: Record<string, Record<string, unknown>>
  /**
   * Skip this entry when pre-downloading. Bundled addons have no model to fetch, and a few entries
   * are deliberately loaded cold by their tests.
   */
  skipPreDownload?: boolean
  /**
   * Platforms that skip the pre-download for this entry while still defining it. A leg that never
   * loads the model still needs the definition -- `assessModelFit` describes a load without
   * running it -- but must not pay for the weights.
   */
  skipPreDownloadOn?: string[]
}

export type ResourceTable = Record<string, ResourceEntry>

/**
 * Replace `$const` and `$asset` placeholders with what this client resolves them to, leaving
 * everything else exactly as written.
 */
export interface ResourceResolvers {
  const: (name: string) => unknown
  asset: (kind: string, file: string) => unknown
  /** Only ever reached by an entry that names one; may throw elsewhere. */
  packageAsset?: (pkg: string, file: string) => unknown
}

export function resolveResourceValue(value: unknown, resolvers: ResourceResolvers): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => resolveResourceValue(entry, resolvers))
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.$const === 'string') return resolvers.const(record.$const)
    if (record.$asset && typeof record.$asset === 'object') {
      const { kind, file } = record.$asset as { kind: string; file: string }
      return resolvers.asset(kind, file)
    }
    if (record.$packageAsset && typeof record.$packageAsset === 'object') {
      const { package: pkg, file } = record.$packageAsset as { package: string; file: string }
      if (!resolvers.packageAsset) {
        throw new Error(`no packageAsset resolver for "${pkg}/${file}" on this client`)
      }
      return resolvers.packageAsset(pkg, file)
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, resolveResourceValue(entry, resolvers)])
    )
  }
  return value
}

/** Await every promise a resolver left in the tree. */
async function settleDeep(value: unknown): Promise<unknown> {
  const settled = await value
  if (Array.isArray(settled)) return Promise.all(settled.map(settleDeep))
  if (settled && typeof settled === 'object') {
    const entries = await Promise.all(
      Object.entries(settled as Record<string, unknown>).map(
        async ([key, entry]) => [key, await settleDeep(entry)] as const
      )
    )
    return Object.fromEntries(entries)
  }
  return settled
}

/** Register every table entry this platform defines. */
export function applyResourceTable(
  table: ResourceTable,
  platform: string,
  define: (dep: string, definition: Record<string, unknown>) => void,
  resolvers: ResourceResolvers
): void {
  const platformSegments = platform.split('-')
  const appliesHere = (entry: string): boolean => {
    if (entry === platform) return true
    const segments = entry.split('-')
    if (segments.length >= platformSegments.length) return false
    return segments.every((segment, index) => segment === platformSegments[index])
  }

  for (const [dep, entry] of Object.entries(table)) {
    if (entry.on && !entry.on.some((name) => name === platform || appliesHere(name))) continue
    const { on: _on, configOn, config, skipPreDownloadOn, ...rest } = entry

    if (skipPreDownloadOn?.some((name) => name === platform || appliesHere(name))) {
      rest.skipPreDownload = true
    }

    const overrides = Object.entries(configOn ?? {})
      .filter(([name]) => appliesHere(name) || name === platform)
      .map(([, patch]) => patch)

    const definition = resolveResourceValue(rest, resolvers) as Record<string, unknown>

    if (config || overrides.length > 0) {
      const merged = { ...(config ?? {}), ...Object.assign({}, ...overrides) }
      // Always a resolver, never a plain object: a client may resolve an asset asynchronously --
      // mobile resolves a bundled URI -- and a config that was an object on one client and a
      // promise-bearing object on another would be a resource that differs by more than its
      // platform override.
      definition.config = async () => settleDeep(resolveResourceValue(merged, resolvers))
    }

    define(dep, definition)
  }
}
