import type { QVACModelEntry, QVACRegistryClient } from '@qvac/registry-client'
import type { RegistryItem } from '@/models/registry/models'
import { generateShortHash } from '@/utils/formatting'
import {
  COREML_COMPONENTS,
  getCatalogCoremlSidecars,
  getCoremlSetKeySource,
  getCoremlSidecarSpec,
  getRetiredCoremlSidecarSpec,
  type CoremlSidecarSpec
} from '@/utils/cache/layout'
import { getModelsCacheDir } from '@/utils/cache/paths'
import { calculateCachedFileChecksum, renameWithCachedChecksum } from '@/utils/checksum'
import { validateAndJoinPath } from '@/utils/path-security'
import { modelInputToSrcSchema, registryUrlSchema } from '@/schemas/index'
import { promises as fsPromises } from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { z } from 'zod'

// Family table and catalog lookups: utils/cache/layout.ts.
export { getCoremlSidecarSpec, type CoremlSidecarSpec }

type CompanionSet = NonNullable<RegistryItem['companionSet']>
const CACHE_METADATA_NAME = '.coreml-companions.json'
const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/i)
const cachedFileSchema = z.object({
  key: z.string(),
  registryPath: z.string(),
  registrySource: z.string(),
  targetName: z.string(),
  expectedSize: z.number().int().nonnegative(),
  sha256Checksum: checksumSchema,
  blobCoreKey: z.string(),
  blobBlockOffset: z.number(),
  blobBlockLength: z.number(),
  blobByteOffset: z.number(),
  primary: z.boolean().default(false)
})
const cachedSetSchema = z.object({
  setKey: z.string(),
  primaryKey: z.literal('modelPath'),
  files: z.array(cachedFileSchema)
})

/**
 * For the encoder-less GGUF of a Core ML distribution, the model constant to
 * load instead where its bundles cannot be staged. The loader stages bundles
 * on macOS and iOS alone, so anywhere else such a load is refused up front
 * rather than failing inside the addon after the download.
 */
export function getCoremlOnlyAlternative(
  registryPath: string,
  registrySource: string
): string | undefined {
  return getCoremlSidecarSpec(registryPath, registrySource, 'darwin')?.withoutBundlesUse
}

/**
 * Why a `registry://` model source cannot load on `platform`, or `undefined`
 * when it can. Only the encoder-less GGUF of a Core ML distribution is refused,
 * and only off Apple platforms; every other source is the loader's business.
 */
export function getRegistryModelPlatformRefusal(
  modelSrc: unknown,
  platform: string | undefined
): string | undefined {
  if (platform === 'darwin' || platform === 'ios') return undefined
  const src = modelInputToSrcSchema.safeParse(modelSrc)
  if (!src.success || !src.data.startsWith('registry://')) return undefined
  const url = registryUrlSchema.safeParse(src.data)
  if (!url.success) return undefined

  const { registryPath, registrySource } = url.data
  const alternative = getCoremlOnlyAlternative(registryPath, registrySource)
  if (alternative === undefined) return undefined

  const filename = registryPath.split('/').pop() || registryPath
  return (
    `${filename} is the encoder-less GGUF of a Core ML distribution: it loads on macOS and iOS, ` +
    `where its Core ML encoder and decoder are staged beside it. On ${platform ?? 'this platform'}, ` +
    `load ${alternative} instead.`
  )
}

export function getCoremlSetKey(model: RegistryItem, spec: CoremlSidecarSpec): string {
  return generateShortHash(getCoremlSetKeySource(model, spec))
}

function getCachedSetMetadataPath(
  model: RegistryItem,
  spec: CoremlSidecarSpec,
  cacheDir: string
): string {
  return validateAndJoinPath(cacheDir, 'sets', getCoremlSetKey(model, spec), CACHE_METADATA_NAME)
}

function expectedSidecarPaths(spec: CoremlSidecarSpec): Map<string, string> {
  const paths = new Map<string, string>()
  for (const bundle of spec.bundles) {
    for (const component of COREML_COMPONENTS) {
      paths.set(
        `${spec.modelStem}${bundle.targetSuffix}.mlmodelc/${component}`,
        `${spec.root}${bundle.sourceName}.mlmodelc/${component}`
      )
    }
  }
  return paths
}

function isValidCachedSet(
  set: CompanionSet,
  model: RegistryItem,
  spec: CoremlSidecarSpec
): boolean {
  if (set.setKey !== getCoremlSetKey(model, spec) || set.primaryKey !== 'modelPath') {
    return false
  }

  const primary = set.files.find((file) => file.key === 'modelPath')
  const filename = model.registryPath.split('/').pop()
  if (
    !primary ||
    primary.registryPath !== model.registryPath ||
    primary.targetName !== filename ||
    primary.expectedSize !== model.expectedSize ||
    primary.sha256Checksum !== model.sha256Checksum
  ) {
    return false
  }

  const expected = expectedSidecarPaths(spec)
  const actual = set.files.filter((file) => file.key !== 'modelPath')
  if (
    actual.length === 0 ||
    new Set(set.files.map((file) => file.targetName)).size !== set.files.length
  ) {
    return false
  }
  if (
    actual.some(
      (file) =>
        file.registrySource !== spec.source || expected.get(file.targetName) !== file.registryPath
    )
  ) {
    return false
  }

  for (const bundle of spec.bundles) {
    const prefix = `${spec.modelStem}${bundle.targetSuffix}.mlmodelc/`
    const count = actual.filter((file) => file.targetName.startsWith(prefix)).length
    if (count !== 0 && count !== COREML_COMPONENTS.length) return false
  }
  return true
}

export async function readCachedCoremlCompanionSet(
  model: RegistryItem,
  platform: string | undefined,
  cacheDir = getModelsCacheDir()
): Promise<CompanionSet | undefined> {
  const spec = getCoremlSidecarSpec(model.registryPath, model.registrySource, platform)
  return spec ? readCachedSet(model, spec, cacheDir) : undefined
}

/**
 * The metadata of the set an earlier release staged for `model` and this one
 * no longer stages (`getRetiredCoremlSidecarSpec`), when it is still cached.
 */
export async function readRetiredCoremlCompanionSet(
  model: RegistryItem,
  platform: string | undefined,
  cacheDir = getModelsCacheDir()
): Promise<CompanionSet | undefined> {
  const spec = getRetiredCoremlSidecarSpec(model.registryPath, model.registrySource, platform)
  return spec ? readCachedSet(model, spec, cacheDir) : undefined
}

/** The set directory an earlier release staged for `model`, if this one retired it. */
export function getRetiredCoremlSetDir(
  model: RegistryItem,
  platform: string | undefined,
  cacheDir = getModelsCacheDir()
): string | undefined {
  const spec = getRetiredCoremlSidecarSpec(model.registryPath, model.registrySource, platform)
  return spec ? validateAndJoinPath(cacheDir, 'sets', getCoremlSetKey(model, spec)) : undefined
}

export type RetiredCoremlSetResult =
  /** No retired set is cached. */
  | { status: 'none' }
  /** The set is gone. `singleFilePath` holds a valid GGUF, or the loader downloads one. */
  | { status: 'cleared' }
  /**
   * The set's GGUF is the only valid copy and could not be moved, for example
   * in a read-only cache, so the set is left as it was. Load `ggufPath`
   * through `linkAwayFromCoremlBundles`, never from beside its bundle.
   */
  | { status: 'kept'; ggufPath: string; error: unknown }

/**
 * Clears the set an earlier release staged for `model` and this one no longer
 * stages. The loader now keeps the model at `singleFilePath`. A file there
 * that passes the loader's size and checksum checks stays. Otherwise the set's
 * GGUF replaces it when that one passes them, so the load that follows does
 * not download it again. The set directory, bundles included, is removed only
 * after that, and not at all when its valid GGUF cannot be moved.
 */
export async function clearRetiredCoremlSet(
  model: RegistryItem,
  platform: string | undefined,
  singleFilePath: string,
  cacheDir = getModelsCacheDir()
): Promise<RetiredCoremlSetResult> {
  const setDir = getRetiredCoremlSetDir(model, platform, cacheDir)
  if (setDir === undefined || !(await isDirectory(setDir))) return { status: 'none' }

  const filename = model.registryPath.split('/').pop() || model.registryPath
  const setGguf = validateAndJoinPath(setDir, filename)
  if (!(await holdsModel(singleFilePath, model)) && (await holdsModel(setGguf, model))) {
    try {
      await renameWithCachedChecksum(setGguf, singleFilePath)
    } catch (error) {
      return { status: 'kept', ggufPath: setGguf, error }
    }
  }
  await fsPromises.rm(setDir, { recursive: true, force: true })
  return { status: 'cleared' }
}

/**
 * A path to `ggufPath` in a new directory under `tempDir`, with no Core ML
 * bundle beside it: the engine looks for a bundle only next to the path it
 * loads. Nothing is written beside `ggufPath`.
 */
export async function linkAwayFromCoremlBundles(
  ggufPath: string,
  tempDir = os.tmpdir()
): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(tempDir, 'qvac-gguf-'))
  const link = path.join(dir, path.basename(ggufPath))
  await fsPromises.symlink(ggufPath, link)
  return link
}

// The size and checksum checks the loader runs on a cached file.
async function holdsModel(filePath: string, model: RegistryItem): Promise<boolean> {
  try {
    const stats = await fsPromises.stat(filePath)
    if (!stats.isFile() || stats.size !== model.expectedSize) return false
    if (model.sha256Checksum.length !== 64) return true
    return (await calculateCachedFileChecksum(filePath)) === model.sha256Checksum
  } catch {
    return false
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(target)).isDirectory()
  } catch {
    return false
  }
}

async function readCachedSet(
  model: RegistryItem,
  spec: CoremlSidecarSpec,
  cacheDir: string
): Promise<CompanionSet | undefined> {
  try {
    const raw = await fsPromises.readFile(getCachedSetMetadataPath(model, spec, cacheDir), 'utf8')
    const parsed = cachedSetSchema.safeParse(JSON.parse(raw))
    if (!parsed.success || !isValidCachedSet(parsed.data, model, spec)) return undefined
    return parsed.data
  } catch {
    return undefined
  }
}

export async function writeCachedCoremlCompanionSet(
  set: CompanionSet,
  cacheDir = getModelsCacheDir()
): Promise<void> {
  const setDir = validateAndJoinPath(cacheDir, 'sets', set.setKey)
  await fsPromises.mkdir(setDir, { recursive: true })
  await fsPromises.writeFile(validateAndJoinPath(setDir, CACHE_METADATA_NAME), JSON.stringify(set))
}

export function findCatalogCoremlCompanionSet(
  model: RegistryItem,
  platform: string | undefined
): CompanionSet | undefined {
  const spec = getCoremlSidecarSpec(model.registryPath, model.registrySource, platform)
  if (!spec) return undefined

  const sidecarFiles = getCatalogCoremlSidecars(spec).map(({ key, targetName, entry }) => ({
    key,
    registryPath: entry.registryPath,
    registrySource: entry.registrySource,
    targetName,
    expectedSize: entry.expectedSize,
    sha256Checksum: entry.sha256Checksum,
    blobCoreKey: entry.blobCoreKey,
    blobBlockOffset: entry.blobBlockOffset,
    blobBlockLength: entry.blobBlockLength,
    blobByteOffset: entry.blobByteOffset
  }))
  return createCompanionSet(model, spec, sidecarFiles)
}

export async function findLocallyCachedCoremlCompanionSet(
  model: RegistryItem,
  platform: string | undefined,
  cacheDir = getModelsCacheDir()
): Promise<CompanionSet | undefined> {
  const set =
    (await readCachedCoremlCompanionSet(model, platform, cacheDir)) ??
    findCatalogCoremlCompanionSet(model, platform)
  if (!set) return undefined

  for (const file of set.files) {
    try {
      const path = validateAndJoinPath(cacheDir, 'sets', set.setKey, file.targetName)
      const stat = await fsPromises.stat(path)
      if (!stat.isFile() || stat.size !== file.expectedSize) return undefined
    } catch {
      return undefined
    }
  }
  return set
}

function createCompanionSet(
  model: RegistryItem,
  spec: CoremlSidecarSpec,
  sidecarFiles: CompanionSet['files'][number][]
): CompanionSet | undefined {
  if (sidecarFiles.length === 0) return undefined
  const filename = model.registryPath.split('/').pop() || model.registryPath
  return {
    setKey: getCoremlSetKey(model, spec),
    primaryKey: 'modelPath',
    files: [
      {
        key: 'modelPath',
        registryPath: model.registryPath,
        registrySource: model.registrySource,
        targetName: filename,
        expectedSize: model.expectedSize,
        sha256Checksum: model.sha256Checksum,
        blobCoreKey: model.blobCoreKey,
        blobBlockOffset: model.blobBlockOffset,
        blobBlockLength: model.blobBlockLength,
        blobByteOffset: model.blobByteOffset,
        primary: true
      },
      ...sidecarFiles
    ]
  }
}

/**
 * Build the existing companion-set shape from live registry metadata. The
 * sidecars are optional and are not part of the generated GGUF constants;
 * this lets the SDK use them as soon as the registry has ingested the files.
 */
export async function findCoremlCompanionSet(
  client: Pick<QVACRegistryClient, 'findModels'>,
  model: RegistryItem,
  platform: string | undefined
): Promise<CompanionSet | undefined> {
  const spec = getCoremlSidecarSpec(model.registryPath, model.registrySource, platform)
  if (!spec) return undefined

  const sidecarFiles: CompanionSet['files'][number][] = []
  for (const bundle of spec.bundles) {
    const sourcePrefix = `${spec.root}${bundle.sourceName}.mlmodelc/`
    const registryEntries = await client.findModels({
      gte: { path: sourcePrefix },
      lte: { path: `${sourcePrefix}￿` }
    })
    const byPath = new Map<string, QVACModelEntry>()
    for (const entry of registryEntries) {
      if (entry.source === spec.source && entry.path.startsWith(sourcePrefix)) {
        byPath.set(entry.path, entry)
      }
    }

    // A partially ingested .mlmodelc is not a usable bundle. Other complete
    // bundles (notably Sortformer's batch/AOSC pair) may still be staged.
    const entries = COREML_COMPONENTS.map((component) => byPath.get(sourcePrefix + component))
    if (entries.some((entry) => !entry?.blobBinding?.sha256)) continue

    for (let i = 0; i < COREML_COMPONENTS.length; i++) {
      const component = COREML_COMPONENTS[i]!
      const entry = entries[i]!
      const binding = entry.blobBinding
      sidecarFiles.push({
        key: `${bundle.sourceName}/${component}`,
        registryPath: entry.path,
        registrySource: entry.source,
        targetName: `${spec.modelStem}${bundle.targetSuffix}.mlmodelc/${component}`,
        expectedSize: binding.byteLength,
        sha256Checksum: binding.sha256,
        blobCoreKey:
          typeof binding.coreKey === 'string' ? binding.coreKey : binding.coreKey.toString('hex'),
        blobBlockOffset: binding.blockOffset,
        blobBlockLength: binding.blockLength,
        blobByteOffset: binding.byteOffset
      })
    }
  }

  return createCompanionSet(model, spec, sidecarFiles)
}
