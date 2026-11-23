import { createHash } from 'crypto'

import { BERGAMOT_MODEL_RE, BERGAMOT_MULTILINGUAL_MODEL_RE } from './schemas.ts'
import type { CompanionSetMetadata, CompanionSetMetadataEntry, ProcessedModel } from './types.ts'

/**
 * Detects companion file relationships among processed models and
 * attaches `companionSet` metadata to each primary entry.
 *
 * Detection families:
 *   ONNX pairs:
 *     Primary: registryPath ends with `.onnx`
 *     Companion: `${primaryPath}_data` or `${primaryPath}.data`
 *
 *   Bergamot NMT sets (directory-based):
 *     Primary: `model.<langPair>.intgemm.alphas.bin`
 *     Companions in same directory: lex, vocab/srcvocab+trgvocab, metadata
 *     Multilingual packs (TranslatePsy Nano) drop the pair: `model.intgemm.alphas.bin`
 *     with `vocab.spm` and a direction-named `lex.50.50.<enxx|xxen>.s2t.bin`. Their
 *     vocab and lex files are byte-identical across pack sizes, so each set claims
 *     its own directory's copies, which also keeps them through checksum dedup.
 *
 *   Apple Core ML bundles:
 *     Every file under a `<name>.mlmodelc/` or `<name>.mlpackage/` directory
 *     is a bundle component. No component is a model on its own.
 */
export function groupCompanionSets(models: ProcessedModel[]): ProcessedModel[] {
  const bySourcePath = new Map<string, ProcessedModel>()
  for (const model of models) {
    bySourcePath.set(sourceKey(model.registrySource, model.registryPath), model)
  }

  const companionKeys = new Set<string>()

  groupOnnxCompanions(models, bySourcePath, companionKeys)
  groupBergamotCompanions(models, bySourcePath, companionKeys)
  markCoremlBundleComponents(models, companionKeys)

  return models.map((model) => {
    const key = sourceKey(model.registrySource, model.registryPath)
    if (companionKeys.has(key)) {
      return { ...model, isCompanionOnly: true }
    }
    return model
  })
}

/** A file inside a Core ML bundle or source package, not a loadable model. */
export function isCoremlBundleComponent(registryPath: string): boolean {
  return /(?:^|\/)[^/]+\.(?:mlmodelc|mlpackage)\//.test(registryPath)
}

function markCoremlBundleComponents(models: ProcessedModel[], companionKeys: Set<string>): void {
  for (const model of models) {
    if (isCoremlBundleComponent(model.registryPath)) {
      companionKeys.add(sourceKey(model.registrySource, model.registryPath))
    }
  }
}

function groupOnnxCompanions(
  models: ProcessedModel[],
  bySourcePath: Map<string, ProcessedModel>,
  companionKeys: Set<string>
): void {
  for (const model of models) {
    if (!model.registryPath.endsWith('.onnx')) continue

    const dataKey = findOnnxCompanionKey(model.registrySource, model.registryPath, bySourcePath)
    if (!dataKey) continue

    const companion = bySourcePath.get(dataKey)!
    const primaryFilename = model.registryPath.split('/').pop() || model.registryPath
    const dataFilename = companion.registryPath.split('/').pop() || companion.registryPath

    const setKey = shortHash(`${model.registrySource}:${model.registryPath}`)

    const primaryEntry: CompanionSetMetadataEntry = {
      key: 'modelPath',
      registryPath: model.registryPath,
      registrySource: model.registrySource,
      targetName: primaryFilename,
      expectedSize: model.expectedSize,
      sha256Checksum: model.sha256Checksum,
      blobCoreKey: model.blobCoreKey,
      blobBlockOffset: model.blobBlockOffset,
      blobBlockLength: model.blobBlockLength,
      blobByteOffset: model.blobByteOffset,
      primary: true
    }

    const dataEntry: CompanionSetMetadataEntry = {
      key: 'dataPath',
      registryPath: companion.registryPath,
      registrySource: companion.registrySource,
      targetName: dataFilename,
      expectedSize: companion.expectedSize,
      sha256Checksum: companion.sha256Checksum,
      blobCoreKey: companion.blobCoreKey,
      blobBlockOffset: companion.blobBlockOffset,
      blobBlockLength: companion.blobBlockLength,
      blobByteOffset: companion.blobByteOffset
    }

    const companionSetMetadata: CompanionSetMetadata = {
      setKey,
      primaryKey: 'modelPath',
      files: [primaryEntry, dataEntry]
    }

    model.companionSet = companionSetMetadata
    companionKeys.add(dataKey)
  }
}

function groupBergamotCompanions(
  models: ProcessedModel[],
  bySourcePath: Map<string, ProcessedModel>,
  companionKeys: Set<string>
): void {
  for (const model of models) {
    const paired = model.registryPath.match(BERGAMOT_MODEL_RE)
    const dirPrefix = paired?.[1] ?? model.registryPath.match(BERGAMOT_MULTILINGUAL_MODEL_RE)?.[1]
    if (!dirPrefix) continue

    // Empty for a multilingual pack.
    const langPair = paired?.[2] ?? ''
    const source = model.registrySource

    const companions = findBergamotCompanions(source, dirPrefix, langPair, bySourcePath)
    if (companions.length === 0) continue

    const primaryFilename = model.registryPath.split('/').pop()!
    const setKey = shortHash(`${source}:${model.registryPath}`)

    const primaryEntry: CompanionSetMetadataEntry = {
      key: 'modelPath',
      registryPath: model.registryPath,
      registrySource: source,
      targetName: primaryFilename,
      expectedSize: model.expectedSize,
      sha256Checksum: model.sha256Checksum,
      blobCoreKey: model.blobCoreKey,
      blobBlockOffset: model.blobBlockOffset,
      blobBlockLength: model.blobBlockLength,
      blobByteOffset: model.blobByteOffset,
      primary: true
    }

    const companionEntries: CompanionSetMetadataEntry[] = []
    for (const { key: entryKey, model: comp } of companions) {
      const filename = comp.registryPath.split('/').pop()!
      companionEntries.push({
        key: entryKey,
        registryPath: comp.registryPath,
        registrySource: comp.registrySource,
        targetName: filename,
        expectedSize: comp.expectedSize,
        sha256Checksum: comp.sha256Checksum,
        blobCoreKey: comp.blobCoreKey,
        blobBlockOffset: comp.blobBlockOffset,
        blobBlockLength: comp.blobBlockLength,
        blobByteOffset: comp.blobByteOffset
      })
      companionKeys.add(sourceKey(comp.registrySource, comp.registryPath))
    }

    model.companionSet = {
      setKey,
      primaryKey: 'modelPath',
      files: [primaryEntry, ...companionEntries]
    }
  }
}

function findBergamotCompanions(
  source: string,
  dirPrefix: string,
  langPair: string,
  bySourcePath: Map<string, ProcessedModel>
): { key: string; model: ProcessedModel }[] {
  const found: { key: string; model: ProcessedModel }[] = []
  const infix = langPair ? `.${langPair}` : ''

  const lexModel = langPair
    ? bySourcePath.get(sourceKey(source, `${dirPrefix}lex.50.50.${langPair}.s2t.bin`))
    : findMultilingualLex(source, dirPrefix, bySourcePath)
  if (lexModel) {
    found.push({ key: 'lexPath', model: lexModel })
  }

  const sharedVocabPath = `${dirPrefix}vocab${infix}.spm`
  const sharedVocab = bySourcePath.get(sourceKey(source, sharedVocabPath))
  if (sharedVocab) {
    found.push({ key: 'sharedVocabPath', model: sharedVocab })
  } else {
    const srcVocabPath = `${dirPrefix}srcvocab${infix}.spm`
    const trgVocabPath = `${dirPrefix}trgvocab${infix}.spm`
    const srcVocab = bySourcePath.get(sourceKey(source, srcVocabPath))
    const trgVocab = bySourcePath.get(sourceKey(source, trgVocabPath))
    if (srcVocab && trgVocab) {
      found.push({ key: 'srcVocabPath', model: srcVocab })
      found.push({ key: 'dstVocabPath', model: trgVocab })
    }
  }

  const metadataPath = `${dirPrefix}metadata.json`
  const metadata = bySourcePath.get(sourceKey(source, metadataPath))
  if (metadata) {
    found.push({ key: 'metadataPath', model: metadata })
  }

  return found
}

// A multilingual pack names its shortlist after the direction, not a pair.
const MULTILINGUAL_LEX_RE = /^lex\.50\.50\.[a-z]+\.s2t\.bin$/

function findMultilingualLex(
  source: string,
  dirPrefix: string,
  bySourcePath: Map<string, ProcessedModel>
): ProcessedModel | undefined {
  const prefix = sourceKey(source, dirPrefix)
  for (const [key, model] of bySourcePath) {
    if (key.startsWith(prefix) && MULTILINGUAL_LEX_RE.test(key.slice(prefix.length))) return model
  }
  return undefined
}

function sourceKey(source: string, path: string): string {
  return `${source}:${path}`
}

function findOnnxCompanionKey(
  source: string,
  primaryPath: string,
  bySourcePath: Map<string, ProcessedModel>
): string | undefined {
  const candidates = [`${primaryPath}_data`, `${primaryPath}.data`]

  for (const candidate of candidates) {
    const key = sourceKey(source, candidate)
    if (bySourcePath.has(key)) return key
  }

  return undefined
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').substring(0, 16)
}
