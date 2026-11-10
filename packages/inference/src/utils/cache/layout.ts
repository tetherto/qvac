import { models, type RegistryItem } from '@/models/registry/models'

// Where the models cache keeps each registry model. Pure (no fs or bare-*
// imports) so Node can load it; the loader uses the same rules.

/** detectShardedModel's filename pattern: `<base>-00001-of-00004.gguf`. */
export const SHARD_FILENAME_PATTERN = /^(.+)-(\d{5})-of-(\d{5})(\.\w+)$/

// Apple Core ML sidecars for registry GGUFs. A native addon runs a stage on a
// compiled `.mlmodelc` bundle when one sits next to the GGUF and falls back to
// ggml otherwise, so on macOS and iOS the bundle is downloaded with its GGUF
// into one companion-set directory. The registry publishes a bundle as its
// individual component files, none of which is a model constant of its own.
// TranscribePsy's Core ML distribution goes further: its GGUF carries no
// encoder weights, so that GGUF only loads with its bundles beside it.

export const COREML_COMPONENTS = [
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
  /** Registry source that publishes the family's GGUFs and bundles. */
  source: 's3' | 'hf'
  /**
   * Registry directory holding the family's published `.mlmodelc` bundles.
   * Omitted when the bundles sit in the GGUF's own directory, as the files of
   * one Hugging Face repository revision do.
   */
  root?: string
  /** Selects the family from a GGUF's registry path. */
  pathPattern: RegExp
  /** Captures the model stem (the filename without its quantization tier). */
  stemPattern: RegExp
  /** Bundles the pinned addon actually uses, keyed by model stem. */
  bundlesByStem: Record<string, readonly BundleSpec[]>
  /**
   * Set when the family's GGUF carries no encoder and loads only with its
   * bundles beside it: the model constant to load where the bundles cannot be
   * staged, which is every platform but macOS and iOS.
   */
  withoutBundlesUse?: string
}

export type CoremlSidecarSpec = {
  source: string
  root: string
  modelStem: string
  bundles: readonly BundleSpec[]
  withoutBundlesUse?: string
}

const SIDECAR_FAMILIES: readonly SidecarFamily[] = [
  {
    // The pinned ASR addon supports these encoder sidecars. The other bundles
    // in the registry (CTC, Indic CTC, Nemotron, and TDT 1.1B) must not be
    // downloaded until the addon can actually use them.
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
    // TranscribePsy's Core ML distribution is published on Hugging Face as an
    // encoder-less GGUF with its encoder and decoder bundles beside it; the ASR
    // addon runs both stages on the Neural Engine. The full GGUF
    // (`transcribepsy-250m-eu-sub.gguf`) has no sidecar and runs on ggml.
    source: 'hf',
    pathPattern: /^qvac\/TranscribePsy-250M-EU-sub-coreml\/resolve\//,
    stemPattern: /^(transcribepsy-250m-eu-sub-coreml)\.gguf$/,
    bundlesByStem: {
      'transcribepsy-250m-eu-sub-coreml': [
        { sourceName: 'transcribepsy-250m-eu-sub-coreml-encoder', targetSuffix: '-encoder' },
        { sourceName: 'transcribepsy-250m-eu-sub-coreml-decoder', targetSuffix: '-decoder' }
      ]
    },
    withoutBundlesUse: 'PARAKEET_TRANSCRIBEPSY_250M_Q8_0'
  },
  {
    // The TTS addon runs the Audio8 codec's synthesis stack on this bundle when
    // it sits beside the codec decoder GGUF. Every quantization tier shares the
    // one bundle, which is why its name drops the tier.
    source: 's3',
    root: 'qvac_models_compiled/ggml/audio8/2026-09-30/',
    pathPattern: /\/ggml\/audio-?8\//,
    stemPattern: /^(.+)-(?:f16|f32|q8_0)\.gguf$/,
    bundlesByStem: {
      'audio8-codec-decoder': [{ sourceName: 'audio8-codec-decoder', targetSuffix: '' }]
    }
  }
]

function basename(registryPath: string): string {
  return registryPath.split('/').pop() || registryPath
}

export function getCoremlSidecarSpec(
  registryPath: string,
  registrySource: string,
  platform: string | undefined
): CoremlSidecarSpec | undefined {
  if (platform !== 'darwin' && platform !== 'ios') return undefined

  const filename = registryPath.split('/').pop() || ''
  for (const family of SIDECAR_FAMILIES) {
    if (family.source !== registrySource || !family.pathPattern.test(registryPath)) continue
    const modelStem = filename.match(family.stemPattern)?.[1]
    const bundles = modelStem ? family.bundlesByStem[modelStem] : undefined
    if (modelStem && bundles) {
      return {
        source: family.source,
        root: family.root ?? registryPath.slice(0, registryPath.length - filename.length),
        modelStem,
        bundles,
        ...(family.withoutBundlesUse !== undefined && {
          withoutBundlesUse: family.withoutBundlesUse
        })
      }
    }
  }
  return undefined
}

/** The string a Core ML companion set's key is the short hash of. */
export function getCoremlSetKeySource(model: RegistryItem, spec: CoremlSidecarSpec): string {
  return `${model.registrySource}:${model.registryPath}:coreml:${spec.root}`
}

/**
 * The catalog entries of every bundle the catalog publishes completely, each
 * with the name it takes in the set directory. A bundle missing a component
 * is left out: a partial `.mlmodelc` is not usable.
 */
export function getCatalogCoremlSidecars(
  spec: CoremlSidecarSpec
): { key: string; targetName: string; entry: RegistryItem }[] {
  const sidecars: { key: string; targetName: string; entry: RegistryItem }[] = []
  for (const bundle of spec.bundles) {
    const registryPrefix = `${spec.root}${bundle.sourceName}.mlmodelc/`
    const entries = COREML_COMPONENTS.map((component) =>
      models.find(
        (entry) =>
          entry.registrySource === spec.source && entry.registryPath === registryPrefix + component
      )
    )
    if (entries.some((entry) => !entry)) continue
    entries.forEach((entry, index) =>
      sidecars.push({
        key: `${bundle.sourceName}/${COREML_COMPONENTS[index]}`,
        targetName: `${spec.modelStem}${bundle.targetSuffix}.mlmodelc/${COREML_COMPONENTS[index]}`,
        entry: entry!
      })
    )
  }
  return sidecars
}

/** A single-file model's name in the models cache directory. */
export function getSingleFileCacheName(
  registryPath: string,
  shortHash: (input: string) => string
): string {
  return `${shortHash(registryPath)}_${basename(registryPath)}`
}

export type ModelCacheLayout = {
  /** The model's file or set directory, relative to the models cache directory. */
  path: string
  /** Every registry-pinned file the model needs, relative to the models cache directory. */
  files: { path: string; size: number; sha256: string }[]
}

/**
 * Where the loader keeps `model`, or `undefined` for a sharded model or a Core
 * ML model whose bundles the catalog lacks: their files can come from the live
 * registry. `shortHash` is generateShortHash, passed in to avoid bare-crypto.
 */
export function getModelCacheLayout(
  model: RegistryItem,
  platform: string | undefined,
  shortHash: (input: string) => string
): ModelCacheLayout | undefined {
  const filename = basename(model.registryPath)
  if (SHARD_FILENAME_PATTERN.test(filename)) return undefined

  const set = (setKey: string, files: { targetName: string; size: number; sha256: string }[]) => ({
    path: `sets/${setKey}`,
    files: files.map((file) => ({
      path: `sets/${setKey}/${file.targetName}`,
      size: file.size,
      sha256: file.sha256
    }))
  })

  const spec = getCoremlSidecarSpec(model.registryPath, model.registrySource, platform)
  if (spec) {
    const sidecars = getCatalogCoremlSidecars(spec)
    if (sidecars.length === 0) return undefined
    return set(shortHash(getCoremlSetKeySource(model, spec)), [
      { targetName: filename, size: model.expectedSize, sha256: model.sha256Checksum },
      ...sidecars.map(({ targetName, entry }) => ({
        targetName,
        size: entry.expectedSize,
        sha256: entry.sha256Checksum
      }))
    ])
  }

  if (model.companionSet) {
    return set(
      model.companionSet.setKey,
      model.companionSet.files.map((file) => ({
        targetName: file.targetName,
        size: file.expectedSize,
        sha256: file.sha256Checksum
      }))
    )
  }

  const single = getSingleFileCacheName(model.registryPath, shortHash)
  return {
    path: single,
    files: [{ path: single, size: model.expectedSize, sha256: model.sha256Checksum }]
  }
}
