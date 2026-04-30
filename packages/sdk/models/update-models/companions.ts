import { createHash } from "crypto";
import type {
  ProcessedModel,
  CompanionSetMetadata,
  CompanionSetMetadataEntry,
} from "./types";
import { BERGAMOT_MODEL_RE } from "@/schemas";

/**
 * Detects companion file relationships among processed models and
 * attaches `companionSet` metadata to each primary entry.
 * Companion-only entries are marked with `isCompanionOnly` so
 * codegen can exclude them from exported model constants.
 *
 * Detection families:
 *   ONNX pairs:
 *     Primary: registryPath ends with `.onnx`
 *     Companion: `${primaryPath}_data` or `${primaryPath}.data`
 *
 *   Bergamot NMT sets (directory-based):
 *     Primary: `model.<langPair>.intgemm.alphas.bin`
 *     Companions in same directory: lex, vocab/srcvocab+trgvocab, metadata
 */
export function groupCompanionSets(
  models: ProcessedModel[],
): ProcessedModel[] {
  const bySourcePath = new Map<string, ProcessedModel>();
  for (const model of models) {
    bySourcePath.set(sourceKey(model.registrySource, model.registryPath), model);
  }

  const companionKeys = new Set<string>();

  groupOnnxCompanions(models, bySourcePath, companionKeys);
  groupBergamotCompanions(models, bySourcePath, companionKeys);

  return models.map((model) => {
    const key = sourceKey(model.registrySource, model.registryPath);
    if (companionKeys.has(key)) {
      return { ...model, isCompanionOnly: true };
    }
    return model;
  });
}

function groupOnnxCompanions(
  models: ProcessedModel[],
  bySourcePath: Map<string, ProcessedModel>,
  companionKeys: Set<string>,
): void {
  for (const model of models) {
    if (!model.registryPath.endsWith(".onnx")) continue;

    const dataKey = findOnnxCompanionKey(
      model.registrySource,
      model.registryPath,
      bySourcePath,
    );
    if (!dataKey) continue;

    const companion = bySourcePath.get(dataKey)!;
    const primaryFilename = model.registryPath.split("/").pop() || model.registryPath;
    const dataFilename = companion.registryPath.split("/").pop() || companion.registryPath;

    const setKey = shortHash(
      `${model.registrySource}:${model.registryPath}`,
    );

    const primaryEntry: CompanionSetMetadataEntry = {
      key: "modelPath",
      registryPath: model.registryPath,
      registrySource: model.registrySource,
      targetName: primaryFilename,
      expectedSize: model.expectedSize,
      sha256Checksum: model.sha256Checksum,
      blobCoreKey: model.blobCoreKey,
      blobBlockOffset: model.blobBlockOffset,
      blobBlockLength: model.blobBlockLength,
      blobByteOffset: model.blobByteOffset,
      primary: true,
    };

    const dataEntry: CompanionSetMetadataEntry = {
      key: "dataPath",
      registryPath: companion.registryPath,
      registrySource: companion.registrySource,
      targetName: dataFilename,
      expectedSize: companion.expectedSize,
      sha256Checksum: companion.sha256Checksum,
      blobCoreKey: companion.blobCoreKey,
      blobBlockOffset: companion.blobBlockOffset,
      blobBlockLength: companion.blobBlockLength,
      blobByteOffset: companion.blobByteOffset,
    };

    const companionSetMetadata: CompanionSetMetadata = {
      setKey,
      primaryKey: "modelPath",
      files: [primaryEntry, dataEntry],
    };

    model.companionSet = companionSetMetadata;
    companionKeys.add(dataKey);
  }
}

function groupBergamotCompanions(
  models: ProcessedModel[],
  bySourcePath: Map<string, ProcessedModel>,
  companionKeys: Set<string>,
): void {
  for (const model of models) {
    const match = model.registryPath.match(BERGAMOT_MODEL_RE);
    if (!match?.[1] || !match[2]) continue;

    const dirPrefix = match[1];
    const langPair = match[2];
    const source = model.registrySource;

    const companions = findBergamotCompanions(
      source,
      dirPrefix,
      langPair,
      bySourcePath,
    );
    if (companions.length === 0) continue;

    const primaryFilename = model.registryPath.split("/").pop()!;
    const setKey = shortHash(`${source}:${model.registryPath}`);

    const primaryEntry: CompanionSetMetadataEntry = {
      key: "modelPath",
      registryPath: model.registryPath,
      registrySource: source,
      targetName: primaryFilename,
      expectedSize: model.expectedSize,
      sha256Checksum: model.sha256Checksum,
      blobCoreKey: model.blobCoreKey,
      blobBlockOffset: model.blobBlockOffset,
      blobBlockLength: model.blobBlockLength,
      blobByteOffset: model.blobByteOffset,
      primary: true,
    };

    const companionEntries: CompanionSetMetadataEntry[] = [];
    for (const { key: entryKey, model: comp } of companions) {
      const filename = comp.registryPath.split("/").pop()!;
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
        blobByteOffset: comp.blobByteOffset,
      });
      companionKeys.add(sourceKey(comp.registrySource, comp.registryPath));
    }

    model.companionSet = {
      setKey,
      primaryKey: "modelPath",
      files: [primaryEntry, ...companionEntries],
    };
  }
}

function findBergamotCompanions(
  source: string,
  dirPrefix: string,
  langPair: string,
  bySourcePath: Map<string, ProcessedModel>,
): { key: string; model: ProcessedModel }[] {
  const found: { key: string; model: ProcessedModel }[] = [];

  const lexPath = `${dirPrefix}lex.50.50.${langPair}.s2t.bin`;
  const lexModel = bySourcePath.get(sourceKey(source, lexPath));
  if (lexModel) {
    found.push({ key: "lexPath", model: lexModel });
  }

  const sharedVocabPath = `${dirPrefix}vocab.${langPair}.spm`;
  const sharedVocab = bySourcePath.get(sourceKey(source, sharedVocabPath));
  if (sharedVocab) {
    found.push({ key: "sharedVocabPath", model: sharedVocab });
  } else {
    const srcVocabPath = `${dirPrefix}srcvocab.${langPair}.spm`;
    const trgVocabPath = `${dirPrefix}trgvocab.${langPair}.spm`;
    const srcVocab = bySourcePath.get(sourceKey(source, srcVocabPath));
    const trgVocab = bySourcePath.get(sourceKey(source, trgVocabPath));
    if (srcVocab && trgVocab) {
      found.push({ key: "srcVocabPath", model: srcVocab });
      found.push({ key: "dstVocabPath", model: trgVocab });
    }
  }

  const metadataPath = `${dirPrefix}metadata.json`;
  const metadata = bySourcePath.get(sourceKey(source, metadataPath));
  if (metadata) {
    found.push({ key: "metadataPath", model: metadata });
  }

  return found;
}

function sourceKey(source: string, path: string): string {
  return `${source}:${path}`;
}

function findOnnxCompanionKey(
  source: string,
  primaryPath: string,
  bySourcePath: Map<string, ProcessedModel>,
): string | undefined {
  const candidates = [
    `${primaryPath}_data`,
    `${primaryPath}.data`,
  ];

  for (const candidate of candidates) {
    const key = sourceKey(source, candidate);
    if (bySourcePath.has(key)) return key;
  }

  return undefined;
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").substring(0, 16);
}
