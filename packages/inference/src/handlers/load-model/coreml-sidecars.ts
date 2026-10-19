import type { QVACModelEntry, QVACRegistryClient } from '@qvac/registry-client'
import type { RegistryItem } from '@/models/registry/models'
import { models } from '@/models/registry/models'
import { generateShortHash } from '@/utils/formatting'
import { getModelsCacheDir } from '@/utils/cache/paths'
import { validateAndJoinPath } from '@/utils/path-security'
import { promises as fsPromises } from 'bare-fs'
import { z } from 'zod'

// Apple Core ML sidecars for registry GGUFs. A native addon runs a stage on a
// compiled `.mlmodelc` bundle when one sits next to the GGUF and falls back to
// ggml otherwise, so on macOS and iOS the bundle is downloaded with its GGUF
// into one companion-set directory. The registry publishes a bundle as its
// individual component files, none of which is a model constant of its own.

const COREML_COMPONENTS = [
  'analytics/coremldata.bin',
  'coremldata.bin',
  'metadata.json',
  'model.mil',
  'weights/weight.bin'
] as const

type BundleSpec = { sourceName: string; targetSuffix: string }

/**
 * A model family whose GGUFs the native addon pairs with compiled Core ML
 * bundles staged beside them. The addon finds a bundle by name next to the
 * GGUF, as `<modelStem><targetSuffix>.mlmodelc`.
 */
type SidecarFamily = {
  /** Registry directory holding the family's published `.mlmodelc` bundles. */
  root: string
  /** Selects the family from a GGUF's registry path. */
  pathPattern: RegExp
  /** Captures the model stem (the filename without its quantization tier). */
  stemPattern: RegExp
  /** Bundles the pinned addon actually uses, keyed by model stem. */
  bundlesByStem: Record<string, readonly BundleSpec[]>
}

export type CoremlSidecarSpec = {
  root: string
  modelStem: string
  bundles: readonly BundleSpec[]
}

const SIDECAR_FAMILIES: readonly SidecarFamily[] = [
  {
    // The pinned ASR addon supports these encoder sidecars. The other bundles
    // in the registry (CTC, Indic CTC, Nemotron, and TDT 1.1B) must not be
    // downloaded until the addon can actually use them.
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
    // The TTS addon runs the Audio8 codec's synthesis stack on this bundle when
    // it sits beside the codec decoder GGUF. Every quantization tier shares the
    // one bundle, which is why its name drops the tier.
    root: 'qvac_models_compiled/ggml/audio8/2026-09-30/',
    pathPattern: /\/ggml\/audio-?8\//,
    stemPattern: /^(.+)-(?:f16|f32|q8_0)\.gguf$/,
    bundlesByStem: {
      'audio8-codec-decoder': [{ sourceName: 'audio8-codec-decoder', targetSuffix: '' }]
    }
  }
]

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

export function getCoremlSidecarSpec(
  registryPath: string,
  registrySource: string,
  platform: string | undefined
): CoremlSidecarSpec | undefined {
  if ((platform !== 'darwin' && platform !== 'ios') || registrySource !== 's3') return undefined

  const filename = registryPath.split('/').pop() || ''
  for (const family of SIDECAR_FAMILIES) {
    if (!family.pathPattern.test(registryPath)) continue
    const modelStem = filename.match(family.stemPattern)?.[1]
    const bundles = modelStem ? family.bundlesByStem[modelStem] : undefined
    if (modelStem && bundles) return { root: family.root, modelStem, bundles }
  }
  return undefined
}

export function getCoremlSetKey(model: RegistryItem, spec: CoremlSidecarSpec): string {
  return generateShortHash(`${model.registrySource}:${model.registryPath}:coreml:${spec.root}`)
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
  if (actual.some((file) => expected.get(file.targetName) !== file.registryPath)) return false

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
  if (!spec) return undefined

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

  const sidecarFiles: CompanionSet['files'][number][] = []
  for (const bundle of spec.bundles) {
    const targetPrefix = `${spec.modelStem}${bundle.targetSuffix}.mlmodelc/`
    const registryPrefix = `${spec.root}${bundle.sourceName}.mlmodelc/`
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

  return createCompanionSet(model, spec, sidecarFiles)
}
