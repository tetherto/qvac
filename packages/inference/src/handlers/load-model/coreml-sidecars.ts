import type { QVACModelEntry, QVACRegistryClient } from '@qvac/registry-client'
import type { RegistryItem } from '@/models/registry/models'
import { generateShortHash } from '@/utils/formatting'
import {
  COREML_COMPONENTS,
  coremlBundleComponents,
  coremlOsSelection,
  getCatalogCoremlSidecars,
  getCoremlSetKeySource,
  getCoremlSidecarSpec,
  getSingleFileCacheName,
  selectCoremlBundles,
  type CoremlSidecarSpec
} from '@/utils/cache/layout'
import { getDarwinMajor } from '@/utils/darwin-version'
import { getModelsCacheDir, hasFileOfSize } from '@/utils/cache/paths'
import { validateAndJoinPath } from '@/utils/path-security'
import { modelInputToSrcSchema, registryUrlSchema } from '@/schemas/index'
import { promises as fsPromises } from 'bare-fs'
import { z } from 'zod'

// Family table and catalog lookups: utils/cache/layout.ts.
export { getCoremlSidecarSpec, type CoremlSidecarSpec }

type CompanionSet = NonNullable<RegistryItem['companionSet']>
type BundleSpec = CoremlSidecarSpec['bundles'][number]
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
  files: z.array(cachedFileSchema),
  // The OS-dependent bundle choice the set was staged under; absent for ''.
  osSelection: z.string().optional()
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
    const components = new Set(
      actual
        .filter((file) => file.targetName.startsWith(prefix))
        .map((file) => file.targetName.slice(prefix.length))
    )
    const complete = coremlBundleComponents((component) =>
      components.has(component) ? component : undefined
    )
    if (components.size !== 0 && complete === undefined) return false
  }
  return true
}

/**
 * The set saved when the model's bundles were last staged from live registry
 * metadata. A set staged under another OS-dependent choice is not reused: a
 * device that staged the fixed encoders on macOS 14 looks again on macOS 15.
 */
export async function readCachedCoremlCompanionSet(
  model: RegistryItem,
  platform: string | undefined,
  cacheDir = getModelsCacheDir(),
  darwinMajor = getDarwinMajor(platform)
): Promise<CompanionSet | undefined> {
  const spec = getCoremlSidecarSpec(model.registryPath, model.registrySource, platform)
  if (!spec) return undefined

  try {
    const raw = await fsPromises.readFile(getCachedSetMetadataPath(model, spec, cacheDir), 'utf8')
    const parsed = cachedSetSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return undefined
    const { osSelection = '', ...set } = parsed.data
    if (osSelection !== coremlOsSelection(spec.bundles, darwinMajor)) return undefined
    return isValidCachedSet(set, model, spec) ? set : undefined
  } catch {
    return undefined
  }
}

/** The OS-dependent bundle choice for `model` on this device, saved with its staged set. */
export function getCoremlOsSelection(
  model: RegistryItem,
  platform: string | undefined,
  darwinMajor = getDarwinMajor(platform)
): string {
  const spec = getCoremlSidecarSpec(model.registryPath, model.registrySource, platform)
  return spec ? coremlOsSelection(spec.bundles, darwinMajor) : ''
}

export async function writeCachedCoremlCompanionSet(
  set: CompanionSet,
  cacheDir = getModelsCacheDir(),
  osSelection = ''
): Promise<void> {
  const setDir = validateAndJoinPath(cacheDir, 'sets', set.setKey)
  await fsPromises.mkdir(setDir, { recursive: true })
  await fsPromises.writeFile(
    validateAndJoinPath(setDir, CACHE_METADATA_NAME),
    JSON.stringify(osSelection === '' ? set : { ...set, osSelection })
  )
}

export function findCatalogCoremlCompanionSet(
  model: RegistryItem,
  platform: string | undefined,
  darwinMajor = getDarwinMajor(platform)
): CompanionSet | undefined {
  const spec = getCoremlSidecarSpec(model.registryPath, model.registrySource, platform)
  if (!spec) return undefined

  const sidecarFiles = getCatalogCoremlSidecars(spec, darwinMajor).map(
    ({ key, targetName, entry }) => ({
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
    })
  )
  return createCompanionSet(model, spec, sidecarFiles)
}

export async function findLocallyCachedCoremlCompanionSet(
  model: RegistryItem,
  platform: string | undefined,
  cacheDir = getModelsCacheDir(),
  darwinMajor = getDarwinMajor(platform)
): Promise<CompanionSet | undefined> {
  const set =
    (await readCachedCoremlCompanionSet(model, platform, cacheDir, darwinMajor)) ??
    findCatalogCoremlCompanionSet(model, platform, darwinMajor)
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

/**
 * Where the loader keeps a Core ML family's model when the catalog does not
 * list its bundles: the set it staged from live registry metadata, or the GGUF
 * alone when the registry had no bundles for it then. `undefined` when neither
 * is fully on disk, and for every other model.
 */
export async function findCachedLiveCoremlModelPath(
  model: RegistryItem,
  platform: string | undefined,
  cacheDir = getModelsCacheDir(),
  darwinMajor = getDarwinMajor(platform)
): Promise<string | undefined> {
  if (!getCoremlSidecarSpec(model.registryPath, model.registrySource, platform)) return undefined

  const set = await findLocallyCachedCoremlCompanionSet(model, platform, cacheDir, darwinMajor)
  const primary = set?.files.find((file) => file.key === set.primaryKey)
  if (set && primary) {
    return validateAndJoinPath(cacheDir, 'sets', set.setKey, primary.targetName)
  }

  const single = validateAndJoinPath(
    cacheDir,
    getSingleFileCacheName(model.registryPath, generateShortHash)
  )
  return (await hasFileOfSize(single, model.expectedSize)) ? single : undefined
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
  platform: string | undefined,
  darwinMajor = getDarwinMajor(platform)
): Promise<CompanionSet | undefined> {
  const spec = getCoremlSidecarSpec(model.registryPath, model.registrySource, platform)
  if (!spec) return undefined

  // One range query covers every bundle of the model: they share the family
  // root and the longest common prefix of their names.
  const queryPrefix = spec.root + commonPrefix(spec.bundles.map((bundle) => bundle.sourceName))
  const registryEntries = await client.findModels({
    gte: { path: queryPrefix },
    lte: { path: `${queryPrefix}\uffff` }
  })
  const byPath = new Map<string, QVACModelEntry>()
  for (const entry of registryEntries) {
    if (entry.source === spec.source && entry.path.startsWith(queryPrefix)) {
      byPath.set(entry.path, entry)
    }
  }

  // A partially ingested .mlmodelc is not a usable bundle. Other complete
  // bundles (notably Sortformer's batch/AOSC pair) may still be staged.
  const componentsOf = (bundle: BundleSpec) =>
    coremlBundleComponents((component) => {
      const entry = byPath.get(`${spec.root}${bundle.sourceName}.mlmodelc/${component}`)
      return entry?.blobBinding?.sha256 ? entry : undefined
    })
  const staged = selectCoremlBundles(
    spec.bundles,
    (bundle) => componentsOf(bundle) !== undefined,
    darwinMajor
  )

  const sidecarFiles: CompanionSet['files'][number][] = []
  for (const bundle of staged) {
    for (const { component, entry } of componentsOf(bundle)!) {
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

function commonPrefix(names: readonly string[]): string {
  let prefix = names[0] ?? ''
  for (const name of names) {
    while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1)
  }
  return prefix
}
