import type { QVACModelEntry, QVACRegistryClient } from '@qvac/registry-client'
import type { RegistryItem } from '@/models/registry/models'
import { models } from '@/models/registry/models'
import { generateShortHash } from '@/utils/formatting'
import { getModelsCacheDir } from '@/utils/cache/paths'
import { validateAndJoinPath } from '@/utils/path-security'
import { promises as fsPromises } from 'bare-fs'
import { z } from 'zod'

const COREML_ROOT = 'qvac_models_compiled/ggml/parakeet/2026-09-28/'
const COREML_COMPONENTS = [
  'analytics/coremldata.bin',
  'coremldata.bin',
  'metadata.json',
  'model.mil',
  'weights/weight.bin'
] as const

type BundleSpec = { sourceName: string; targetSuffix: string }
type CompanionSet = NonNullable<RegistryItem['companionSet']>
const CACHE_METADATA_NAME = '.coreml-companions.json'
const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/i)
const cachedFileSchema = z.object({
  key: z.string(),
  registryPath: z.string(),
  registrySource: z.literal('s3'),
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

export function getParakeetCoremlSetKey(model: RegistryItem): string {
  return generateShortHash(`${model.registrySource}:${model.registryPath}:coreml:${COREML_ROOT}`)
}

function getCachedSetMetadataPath(model: RegistryItem, cacheDir: string): string {
  return validateAndJoinPath(cacheDir, 'sets', getParakeetCoremlSetKey(model), CACHE_METADATA_NAME)
}

function expectedSidecarPaths(
  spec: NonNullable<ReturnType<typeof getParakeetCoremlBundleSpecs>>
): Map<string, string> {
  const paths = new Map<string, string>()
  for (const bundle of spec.bundles) {
    for (const component of COREML_COMPONENTS) {
      paths.set(
        `${spec.modelStem}${bundle.targetSuffix}.mlmodelc/${component}`,
        `${COREML_ROOT}${bundle.sourceName}.mlmodelc/${component}`
      )
    }
  }
  return paths
}

function isValidCachedSet(
  set: CompanionSet,
  model: RegistryItem,
  platform: string | undefined
): boolean {
  const spec = getParakeetCoremlBundleSpecs(model.registryPath, model.registrySource, platform)
  if (!spec || set.setKey !== getParakeetCoremlSetKey(model) || set.primaryKey !== 'modelPath') {
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
  if (actual.some((file) => expected.get(file.targetName) !== file.registryPath)) return false

  for (const bundle of spec.bundles) {
    const prefix = `${spec.modelStem}${bundle.targetSuffix}.mlmodelc/`
    const count = actual.filter((file) => file.targetName.startsWith(prefix)).length
    if (count !== 0 && count !== COREML_COMPONENTS.length) return false
  }
  return true
}

export async function readCachedParakeetCoremlCompanionSet(
  model: RegistryItem,
  platform: string | undefined,
  cacheDir = getModelsCacheDir()
): Promise<CompanionSet | undefined> {
  try {
    const raw = await fsPromises.readFile(getCachedSetMetadataPath(model, cacheDir), 'utf8')
    const parsed = cachedSetSchema.safeParse(JSON.parse(raw))
    if (!parsed.success || !isValidCachedSet(parsed.data, model, platform)) return undefined
    return parsed.data
  } catch {
    return undefined
  }
}

export async function writeCachedParakeetCoremlCompanionSet(
  model: RegistryItem,
  set: CompanionSet,
  cacheDir = getModelsCacheDir()
): Promise<void> {
  const path = getCachedSetMetadataPath(model, cacheDir)
  await fsPromises.mkdir(validateAndJoinPath(cacheDir, 'sets', set.setKey), { recursive: true })
  await fsPromises.writeFile(path, JSON.stringify(set))
}

export function findCatalogParakeetCoremlCompanionSet(
  model: RegistryItem,
  platform: string | undefined
): CompanionSet | undefined {
  const spec = getParakeetCoremlBundleSpecs(model.registryPath, model.registrySource, platform)
  if (!spec) return undefined

  const sidecarFiles: CompanionSet['files'][number][] = []
  for (const bundle of spec.bundles) {
    const targetPrefix = `${spec.modelStem}${bundle.targetSuffix}.mlmodelc/`
    const registryPrefix = `${COREML_ROOT}${bundle.sourceName}.mlmodelc/`
    const entries = COREML_COMPONENTS.map((component) =>
      models.find(
        (entry) =>
          entry.registrySource === 's3' && entry.registryPath === registryPrefix + component
      )
    )
    if (entries.some((entry) => !entry)) continue
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!
      sidecarFiles.push({
        key: `${bundle.sourceName}/${COREML_COMPONENTS[index]}`,
        registryPath: entry.registryPath,
        registrySource: entry.registrySource,
        targetName: targetPrefix + COREML_COMPONENTS[index],
        expectedSize: entry.expectedSize,
        sha256Checksum: entry.sha256Checksum,
        blobCoreKey: entry.blobCoreKey,
        blobBlockOffset: entry.blobBlockOffset,
        blobBlockLength: entry.blobBlockLength,
        blobByteOffset: entry.blobByteOffset
      })
    }
  }
  return createCompanionSet(model, sidecarFiles)
}

export async function findLocallyCachedParakeetCoremlCompanionSet(
  model: RegistryItem,
  platform: string | undefined,
  cacheDir = getModelsCacheDir()
): Promise<CompanionSet | undefined> {
  const set =
    (await readCachedParakeetCoremlCompanionSet(model, platform, cacheDir)) ??
    findCatalogParakeetCoremlCompanionSet(model, platform)
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
  sidecarFiles: CompanionSet['files'][number][]
): CompanionSet | undefined {
  if (sidecarFiles.length === 0) return undefined
  const filename = model.registryPath.split('/').pop() || model.registryPath
  return {
    setKey: getParakeetCoremlSetKey(model),
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

// The pinned ASR addon supports these encoder sidecars. The other bundles in
// the registry (CTC, Indic CTC, Nemotron, and TDT 1.1B) must not be downloaded
// until the addon can actually use them.
const SIDECARS_BY_MODEL: Record<string, readonly BundleSpec[]> = {
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

export function getParakeetCoremlBundleSpecs(
  registryPath: string,
  registrySource: string,
  platform: string | undefined
): { modelStem: string; bundles: readonly BundleSpec[] } | undefined {
  if ((platform !== 'darwin' && platform !== 'ios') || registrySource !== 's3') return undefined
  if (!registryPath.includes('/ggml/parakeet/')) return undefined

  const filename = registryPath.split('/').pop() || ''
  const match = filename.match(/^(.+)\.(?:f16|q4_0|q8_0)\.gguf$/)
  if (!match?.[1]) return undefined

  const bundles = SIDECARS_BY_MODEL[match[1]]
  return bundles ? { modelStem: match[1], bundles } : undefined
}

/**
 * Build the existing companion-set shape from live registry metadata. The
 * sidecars are optional and are not part of the generated GGUF constants;
 * this lets the SDK use them as soon as the registry has ingested the files.
 */
export async function findParakeetCoremlCompanionSet(
  client: Pick<QVACRegistryClient, 'findModels'>,
  model: RegistryItem,
  platform: string | undefined
): Promise<CompanionSet | undefined> {
  const spec = getParakeetCoremlBundleSpecs(model.registryPath, model.registrySource, platform)
  if (!spec) return undefined

  const sidecarFiles: CompanionSet['files'][number][] = []
  for (const bundle of spec.bundles) {
    const sourcePrefix = `${COREML_ROOT}${bundle.sourceName}.mlmodelc/`
    const registryEntries = await client.findModels({
      gte: { path: sourcePrefix },
      lte: { path: `${sourcePrefix}\uffff` }
    })
    const byPath = new Map<string, QVACModelEntry>()
    for (const entry of registryEntries) {
      if (entry.source === 's3' && entry.path.startsWith(sourcePrefix)) {
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

  return createCompanionSet(model, sidecarFiles)
}
