import type { QVACModelEntry, QVACRegistryClient } from '@qvac/registry-client'
import type { RegistryItem } from '@/models/registry/models'
import { generateShortHash } from '@/utils/formatting'

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

export function getParakeetCoremlSetKey(model: RegistryItem): string {
  return generateShortHash(`${model.registrySource}:${model.registryPath}:coreml:${COREML_ROOT}`)
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
