import type { QVACRegistryClient } from '@qvac/registry-client'
import type { AbortSignal } from 'bare-abort-controller'
import { promises as fsPromises } from 'bare-fs'
import { z } from 'zod'
import type { ModelProgressUpdate } from '@/schemas/index'
import { models, type RegistryItem } from '@/models/registry/models'
import { generateShortHash } from '@/utils/formatting'
import { getModelsCacheDir } from '@/utils/cache/paths'
import { coremlBundleNameOf } from '@/utils/cache/layout'
import { validateAndJoinPath } from '@/utils/path-security'
import { downloadCompanionSetFromRegistry } from '@/handlers/load-model/registry-companion-set'
import type { DownloadHooks } from '@/handlers/load-model/types'
import { ModelNotFoundError } from '@/errors/index'
import { getEngineLogger } from '@/logging/index'

// A compiled Core ML bundle named by its registry directory, for addons that
// take a `.mlmodelc` path of their own rather than finding it beside a GGUF.
// The registry publishes a bundle as its component files under that
// directory; they are staged into a companion-set directory that keeps the
// bundle's name and layout, and the loader returns the bundle directory.

type CompanionSet = NonNullable<RegistryItem['companionSet']>
type CompanionSetFile = CompanionSet['files'][number]

export type CoremlBundle = {
  registrySource: string
  /** The bundle directory's registry path, without a trailing slash. */
  bundlePath: string
  /** The directory's own name, ending in `.mlmodelc`. */
  bundleName: string
}

const CACHE_METADATA_NAME = '.coreml-bundle.json'
const ROOT_COMPONENT = 'coremldata.bin'
const logger = getEngineLogger()

const cachedFileSchema = z.object({
  key: z.string(),
  registryPath: z.string(),
  registrySource: z.string(),
  targetName: z.string(),
  expectedSize: z.number().int().nonnegative(),
  sha256Checksum: z.string().regex(/^[a-f0-9]{64}$/i),
  blobCoreKey: z.string(),
  blobBlockOffset: z.number(),
  blobBlockLength: z.number(),
  blobByteOffset: z.number(),
  primary: z.boolean().default(false)
})
const cachedSetSchema = z.object({
  setKey: z.string(),
  primaryKey: z.string(),
  files: z.array(cachedFileSchema).min(1)
})

/** The Core ML bundle a registry path names, or `undefined` for any other file. */
export function getCoremlBundle(
  registrySource: string,
  registryPath: string
): CoremlBundle | undefined {
  const bundleName = coremlBundleNameOf(registryPath)
  if (bundleName === undefined) return undefined
  return { registrySource, bundlePath: registryPath.replace(/\/+$/, ''), bundleName }
}

export function getCoremlBundleSetKey(bundle: CoremlBundle): string {
  return generateShortHash(`${bundle.registrySource}:${bundle.bundlePath}:coreml-bundle`)
}

/** Where the loader stages the bundle: its own name inside its set directory. */
export function getCoremlBundleDir(bundle: CoremlBundle, cacheDir = getModelsCacheDir()): string {
  return validateAndJoinPath(cacheDir, 'sets', getCoremlBundleSetKey(bundle), bundle.bundleName)
}

/** A component's path inside the bundle, or `undefined` when it is not one. */
function componentOf(bundle: CoremlBundle, registryPath: string): string | undefined {
  const prefix = `${bundle.bundlePath}/`
  if (!registryPath.startsWith(prefix)) return undefined
  const component = registryPath.slice(prefix.length)
  const segments = component.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return undefined
  }
  return component
}

type BundleFile = Omit<CompanionSetFile, 'key' | 'targetName'> & { component: string }

/**
 * The set that stages these files as the bundle, or `undefined` unless the
 * bundle's root `coremldata.bin` is among them: without it Core ML cannot open
 * the bundle, so a listing that lacks it is a partial one.
 */
function createBundleSet(bundle: CoremlBundle, files: BundleFile[]): CompanionSet | undefined {
  if (!files.some((file) => file.component === ROOT_COMPONENT)) return undefined
  const sorted = [...files].sort((a, b) => (a.component < b.component ? -1 : 1))
  return {
    setKey: getCoremlBundleSetKey(bundle),
    primaryKey: ROOT_COMPONENT,
    files: sorted.map(({ component, ...file }) => ({
      ...file,
      key: component,
      targetName: `${bundle.bundleName}/${component}`,
      primary: component === ROOT_COMPONENT
    }))
  }
}

/** The bundle's set from the catalog, when the catalog lists its components. */
export function findCatalogCoremlBundleSet(
  bundle: CoremlBundle,
  catalog: readonly RegistryItem[] = models
): CompanionSet | undefined {
  const files: BundleFile[] = []
  for (const entry of catalog) {
    if (entry.registrySource !== bundle.registrySource) continue
    const component = componentOf(bundle, entry.registryPath)
    if (component === undefined) continue
    files.push({
      component,
      registryPath: entry.registryPath,
      registrySource: entry.registrySource,
      expectedSize: entry.expectedSize,
      sha256Checksum: entry.sha256Checksum,
      blobCoreKey: entry.blobCoreKey,
      blobBlockOffset: entry.blobBlockOffset,
      blobBlockLength: entry.blobBlockLength,
      blobByteOffset: entry.blobByteOffset
    })
  }
  return createBundleSet(bundle, files)
}

/** The bundle's set from live registry metadata, for a bundle the catalog does not list yet. */
export async function findRegistryCoremlBundleSet(
  client: Pick<QVACRegistryClient, 'findModels'>,
  bundle: CoremlBundle
): Promise<CompanionSet | undefined> {
  const prefix = `${bundle.bundlePath}/`
  const entries = await client.findModels({
    gte: { path: prefix },
    lte: { path: `${prefix}\uffff` }
  })

  const files: BundleFile[] = []
  for (const entry of entries) {
    if (entry.source !== bundle.registrySource) continue
    const component = componentOf(bundle, entry.path)
    const binding = entry.blobBinding
    if (component === undefined || !binding?.sha256) continue
    files.push({
      component,
      registryPath: entry.path,
      registrySource: entry.source,
      expectedSize: binding.byteLength,
      sha256Checksum: binding.sha256,
      blobCoreKey:
        typeof binding.coreKey === 'string' ? binding.coreKey : binding.coreKey.toString('hex'),
      blobBlockOffset: binding.blockOffset,
      blobBlockLength: binding.blockLength,
      blobByteOffset: binding.byteOffset
    })
  }
  return createBundleSet(bundle, files)
}

function getCachedSetMetadataPath(bundle: CoremlBundle, cacheDir: string): string {
  return validateAndJoinPath(cacheDir, 'sets', getCoremlBundleSetKey(bundle), CACHE_METADATA_NAME)
}

/**
 * The set saved when the bundle was last staged from live registry metadata,
 * so a staged bundle loads without the registry. A record that does not
 * describe this bundle is ignored.
 */
export async function readCachedCoremlBundleSet(
  bundle: CoremlBundle,
  cacheDir = getModelsCacheDir()
): Promise<CompanionSet | undefined> {
  try {
    const raw = await fsPromises.readFile(getCachedSetMetadataPath(bundle, cacheDir), 'utf8')
    const parsed = cachedSetSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return undefined
    const set = parsed.data
    const valid =
      set.setKey === getCoremlBundleSetKey(bundle) &&
      set.primaryKey === ROOT_COMPONENT &&
      set.files.some((file) => file.key === ROOT_COMPONENT) &&
      set.files.every((file) => {
        const component = componentOf(bundle, file.registryPath)
        return (
          file.registrySource === bundle.registrySource &&
          component === file.key &&
          file.targetName === `${bundle.bundleName}/${component}`
        )
      })
    return valid ? set : undefined
  } catch {
    return undefined
  }
}

export async function writeCachedCoremlBundleSet(
  set: CompanionSet,
  cacheDir = getModelsCacheDir()
): Promise<void> {
  const setDir = validateAndJoinPath(cacheDir, 'sets', set.setKey)
  await fsPromises.mkdir(setDir, { recursive: true })
  await fsPromises.writeFile(validateAndJoinPath(setDir, CACHE_METADATA_NAME), JSON.stringify(set))
}

export interface DownloadCoremlBundleOptions {
  bundle: CoremlBundle
  downloadKey: string
  /** Lists the bundle in the live registry, for a bundle the catalog and the cache lack. */
  findInRegistry: () => Promise<CompanionSet | undefined>
  progressCallback?: ((progress: ModelProgressUpdate) => void) | undefined
  signal?: AbortSignal | undefined
  hooks?: DownloadHooks | undefined
  shouldClearCache?: (() => boolean) | undefined
}

/**
 * Stages a registry Core ML bundle in the models cache and returns its
 * directory. The catalog's listing is used first, then the one saved by an
 * earlier download, then the live registry's.
 *
 * @throws {ModelNotFoundError} When no source lists the bundle's root
 *   `coremldata.bin`.
 */
export async function downloadCoremlBundleFromRegistry(
  options: DownloadCoremlBundleOptions
): Promise<string> {
  const { bundle, findInRegistry, ...download } = options
  const catalogSet = findCatalogCoremlBundleSet(bundle)
  const set = catalogSet ?? (await readCachedCoremlBundleSet(bundle)) ?? (await findInRegistry())
  if (!set) {
    throw new ModelNotFoundError(
      `registry://${bundle.registrySource}/${bundle.bundlePath} (no compiled Core ML bundle ` +
        'with a root coremldata.bin is published there)'
    )
  }

  await downloadCompanionSetFromRegistry({ companionSet: set, ...download })
  if (!catalogSet) {
    try {
      await writeCachedCoremlBundleSet(set)
    } catch (error) {
      logger.warn('Unable to save Core ML bundle cache metadata', {
        bundlePath: bundle.bundlePath,
        error
      })
    }
  }
  return getCoremlBundleDir(bundle)
}
