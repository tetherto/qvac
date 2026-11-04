import { createHash } from 'node:crypto'

/**
 * Mirror of the SDK models cache layout, so CI can cache each model as its own entry before
 * anything is downloaded. Rules in packages/inference:
 *   - single file:   `<shortHash(registryPath)>_<filename>`  (utils/cache/paths.ts)
 *   - sharded model: not cached (the SDK writes an unpinned `<base>.tensors.txt`)
 *   - companion set: `sets/<setKey>/`                         (utils/cache/paths.ts)
 *   - Core ML set:   `sets/<shortHash(source:path:coreml:root)>/` on macOS; not cached when the
 *                    catalog lacks a complete bundle (handlers/load-model/coreml-sidecars.ts)
 * Drift costs a download, never a wrong result: the SDK verifies checksums on load, and the
 * cache action warns about files no entry covers.
 */

export interface RegistryLayoutItem {
  name: string
  registryPath: string
  registrySource: string
  expectedSize: number
  sha256Checksum: string
  companionSet?: {
    setKey: string
    files: readonly { targetName: string; expectedSize: number; sha256Checksum: string }[]
  }
}

export interface PlannedConstant {
  constant: { name: string; registryPath?: string; registrySource?: string }
  owners: readonly string[]
}

export interface ModelCacheFile {
  /** Workspace-relative, POSIX */
  path: string
  size: number
  sha256: string
}

export interface ModelCacheEntry {
  /** Digest of every file's checksum; the cache key */
  contentId: string
  /** The model's file or directory, workspace-relative POSIX; used for drift checks */
  paths: string[]
  /** Exactly what the entry archives: registry-pinned files only, never SDK metadata */
  files: ModelCacheFile[]
  expectedSize: number
  models: string[]
  owners: string[]
}

export interface ModelCachePlanResult {
  entries: ModelCacheEntry[]
  /** Constants with no known layout before download; they stay uncached */
  unresolved: string[]
}

export type HostOs = 'macos' | 'linux' | 'windows'

type Layout = Pick<ModelCacheEntry, 'contentId' | 'paths' | 'files' | 'expectedSize'>

/** Same digest as the SDK's `generateShortHash` (utils/formatting.ts). */
export function shortHash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').substring(0, 16)
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function basename(registryPath: string): string {
  return registryPath.split('/').pop() || registryPath
}

/**
 * Digest of each file's path inside `dir` and checksum. Code-unit sort, not locale: the cache
 * action recomputes it (contentIdFor).
 */
function contentIdOf(files: readonly ModelCacheFile[], dir: string): string {
  const lines = files.map((file) => `${file.path.slice(dir.length)}:${file.sha256}`).sort()
  return sha256(lines.join('\n'))
}

/**
 * Mirror of SIDECAR_FAMILIES and COREML_COMPONENTS in
 * packages/inference/src/handlers/load-model/coreml-sidecars.ts; unit tests compare the two.
 */
const COREML_COMPONENTS = [
  'analytics/coremldata.bin',
  'coremldata.bin',
  'metadata.json',
  'model.mil',
  'weights/weight.bin'
] as const

interface CoremlFamily {
  source: string
  root?: string
  pathPattern: RegExp
  stemPattern: RegExp
  bundlesByStem: Record<string, readonly { sourceName: string; targetSuffix: string }[]>
}

export const COREML_FAMILIES: readonly CoremlFamily[] = [
  {
    source: 's3',
    root: 'qvac_models_compiled/ggml/parakeet/2026-09-28/',
    pathPattern: /\/ggml\/parakeet\//,
    stemPattern: /^(.+)\.(?:f16|q4_0|q8_0)\.gguf$/,
    bundlesByStem: {
      'parakeet-tdt-0.6b-v3': [
        { sourceName: 'parakeet-tdt-0.6b-v3-encoder', targetSuffix: '-encoder' }
      ],
      'parakeet-unified-en-0.6b': [
        { sourceName: 'parakeet-unified-en-0.6b-encoder', targetSuffix: '-encoder' }
      ],
      'parakeet-eou-120m-v1': [
        { sourceName: 'parakeet_realtime_eou_120m-v1-encoder', targetSuffix: '-encoder' }
      ],
      'diar_streaming_sortformer_4spk-v2.1': [
        { sourceName: 'diar_streaming_sortformer_4spk-v2.1-encoder', targetSuffix: '-encoder' },
        {
          sourceName: 'diar_streaming_sortformer_4spk-v2.1-encoder-bypass-pre-encode',
          targetSuffix: '-encoder-bypass-pre-encode'
        }
      ]
    }
  },
  {
    source: 'hf',
    pathPattern: /^qvac\/TranscribePsy-250M-EU-sub-coreml\/resolve\//,
    stemPattern: /^(transcribepsy-250m-eu-sub-coreml)\.gguf$/,
    bundlesByStem: {
      'transcribepsy-250m-eu-sub-coreml': [
        { sourceName: 'transcribepsy-250m-eu-sub-coreml-encoder', targetSuffix: '-encoder' },
        { sourceName: 'transcribepsy-250m-eu-sub-coreml-decoder', targetSuffix: '-decoder' }
      ]
    }
  },
  {
    source: 's3',
    root: 'qvac_models_compiled/ggml/audio8/2026-09-30/',
    pathPattern: /\/ggml\/audio-?8\//,
    stemPattern: /^(.+)-(?:f16|f32|q8_0)\.gguf$/,
    bundlesByStem: {
      'audio8-codec-decoder': [{ sourceName: 'audio8-codec-decoder', targetSuffix: '' }]
    }
  }
]

/** The Core ML family and stem the SDK matches on macOS (getCoremlSidecarSpec), if any. */
function coremlSpecFor(item: RegistryLayoutItem, os: HostOs) {
  if (os !== 'macos') return undefined
  const filename = basename(item.registryPath)
  for (const family of COREML_FAMILIES) {
    if (family.source !== item.registrySource || !family.pathPattern.test(item.registryPath)) {
      continue
    }
    const stem = filename.match(family.stemPattern)?.[1]
    const bundles = stem ? family.bundlesByStem[stem] : undefined
    if (stem && bundles) return { family, stem, bundles, filename }
  }
  return undefined
}

/** The Core ML set the SDK builds on macOS (findCatalogCoremlCompanionSet), or `undefined`. */
export function coremlSetFor(
  item: RegistryLayoutItem,
  os: HostOs,
  byPath: ReadonlyMap<string, RegistryLayoutItem>
): { setKey: string; files: { targetName: string; size: number; sha256: string }[] } | undefined {
  const spec = coremlSpecFor(item, os)
  if (!spec) return undefined
  const { family, stem, bundles, filename } = spec
  const root = family.root ?? item.registryPath.slice(0, item.registryPath.length - filename.length)
  const sidecars: { targetName: string; size: number; sha256: string }[] = []
  for (const bundle of bundles) {
    const components = COREML_COMPONENTS.map((component) =>
      byPath.get(`${family.source}:${root}${bundle.sourceName}.mlmodelc/${component}`)
    )
    if (components.some((entry) => !entry)) continue
    components.forEach((entry, index) =>
      sidecars.push({
        targetName: `${stem}${bundle.targetSuffix}.mlmodelc/${COREML_COMPONENTS[index]}`,
        size: entry!.expectedSize,
        sha256: entry!.sha256Checksum
      })
    )
  }
  if (sidecars.length === 0) return undefined
  return {
    setKey: shortHash(`${item.registrySource}:${item.registryPath}:coreml:${root}`),
    files: [
      { targetName: filename, size: item.expectedSize, sha256: item.sha256Checksum },
      ...sidecars
    ]
  }
}

/** detectShardedModel's pattern (packages/inference/src/utils/shard-utils.ts). */
export const SHARD_FILENAME = /^(.+)-(\d{5})-of-(\d{5})(\.\w+)$/

/**
 * One model's layout relative to the cache directory, or `undefined` when unknown before
 * download. SDK order (handlers/load-model/registry.ts): sharded, Core ML, companion set, single.
 */
export function cacheLayoutFor(
  item: RegistryLayoutItem,
  os: HostOs,
  byPath: ReadonlyMap<string, RegistryLayoutItem> = new Map()
): Layout | undefined {
  const directory = (dir: string, files: ModelCacheFile[]): Layout => ({
    contentId: contentIdOf(files, dir),
    paths: [dir],
    files,
    expectedSize: files.reduce((sum, file) => sum + file.size, 0)
  })

  // The SDK writes `<base>.tensors.txt` beside the shards only on download, and a cache hit on
  // restored shards would load without it. Not registry-pinned, so it cannot be cached here.
  if (SHARD_FILENAME.test(basename(item.registryPath))) return undefined

  const coreml = coremlSetFor(item, os, byPath)
  // No complete bundle in the catalog: the SDK asks the live registry, which may have one.
  if (!coreml && coremlSpecFor(item, os)) return undefined
  if (coreml) {
    const dir = `sets/${coreml.setKey}`
    return directory(
      dir,
      coreml.files.map((file) => ({
        path: `${dir}/${file.targetName}`,
        size: file.size,
        sha256: file.sha256
      }))
    )
  }

  if (item.companionSet) {
    const dir = `sets/${item.companionSet.setKey}`
    return directory(
      dir,
      item.companionSet.files.map((file) => ({
        path: `${dir}/${file.targetName}`,
        size: file.expectedSize,
        sha256: file.sha256Checksum
      }))
    )
  }

  const single = `${shortHash(item.registryPath)}_${basename(item.registryPath)}`
  return {
    contentId: item.sha256Checksum,
    paths: [single],
    files: [{ path: single, size: item.expectedSize, sha256: item.sha256Checksum }],
    expectedSize: item.expectedSize
  }
}

function registryKey(source: string, registryPath: string): string {
  return `${source}:${registryPath}`
}

/** One entry per distinct path; aliases of one registry model share it. */
export function buildModelCachePlan(options: {
  constants: readonly PlannedConstant[]
  registry: readonly RegistryLayoutItem[]
  os: HostOs
  /** Workspace-relative POSIX path of the SDK models cache directory */
  cacheRoot: string
}): ModelCachePlanResult {
  const byName = new Map(options.registry.map((item) => [item.name, item]))
  const byPath = new Map(
    options.registry.map((item) => [registryKey(item.registrySource, item.registryPath), item])
  )
  const root = options.cacheRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const under = (relative: string) => `${root}/${relative}`

  const entries = new Map<string, ModelCacheEntry>()
  const unresolved: string[] = []

  for (const { constant, owners } of options.constants) {
    const item =
      (constant.registryPath && constant.registrySource
        ? byPath.get(registryKey(constant.registrySource, constant.registryPath))
        : undefined) ?? byName.get(constant.name)
    if (!item) {
      unresolved.push(constant.name)
      continue
    }
    const layout = cacheLayoutFor(item, options.os, byPath)
    if (!layout) {
      unresolved.push(constant.name)
      continue
    }
    const paths = layout.paths.map(under)
    const identity = paths.join('\n')
    const existing = entries.get(identity)
    if (existing) {
      if (!existing.models.includes(constant.name)) existing.models.push(constant.name)
      for (const owner of owners) if (!existing.owners.includes(owner)) existing.owners.push(owner)
      continue
    }
    entries.set(identity, {
      ...layout,
      paths,
      files: layout.files.map((file) => ({ ...file, path: under(file.path) })),
      models: [constant.name],
      owners: [...owners]
    })
  }

  return {
    entries: Array.from(entries.values()).sort((a, b) => a.paths[0]!.localeCompare(b.paths[0]!)),
    unresolved
  }
}

/** Union of several legs' entries (seed). */
export function mergeModelCacheEntries(
  lists: readonly (readonly ModelCacheEntry[])[]
): ModelCacheEntry[] {
  const merged = new Map<string, ModelCacheEntry>()
  for (const list of lists) {
    for (const entry of list) {
      const identity = entry.paths.join('\n')
      const existing = merged.get(identity)
      if (!existing) {
        merged.set(identity, { ...entry, models: [...entry.models], owners: [...entry.owners] })
        continue
      }
      for (const model of entry.models) {
        if (!existing.models.includes(model)) existing.models.push(model)
      }
      for (const owner of entry.owners) {
        if (!existing.owners.includes(owner)) existing.owners.push(owner)
      }
    }
  }
  return Array.from(merged.values()).sort((a, b) => a.paths[0]!.localeCompare(b.paths[0]!))
}
