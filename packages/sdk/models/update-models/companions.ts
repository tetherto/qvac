import { createHash } from "crypto";
import type {
  ProcessedModel,
  CompanionSetMetadata,
  CompanionSetMetadataEntry,
} from "./types";

/**
 * Detects companion file relationships among processed models and
 * attaches `companionSet` metadata to each primary entry.
 * Companion-only entries are marked with `isCompanionOnly` so
 * codegen can exclude them from exported model constants.
 *
 * Currently scoped to ONNX pairs. Detection rules:
 *   - Primary: registryPath ends with `.onnx`
 *   - Companion candidates (same registrySource):
 *       `${primaryPath}_data`
 *       `${primaryPath}.data`
 */
export function groupCompanionSets(
  models: ProcessedModel[],
): ProcessedModel[] {
  const bySourcePath = new Map<string, ProcessedModel>();
  for (const model of models) {
    bySourcePath.set(sourceKey(model.registrySource, model.registryPath), model);
  }

  const companionKeys = new Set<string>();

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

  return models.map((model) => {
    const key = sourceKey(model.registrySource, model.registryPath);
    if (companionKeys.has(key)) {
      return { ...model, isCompanionOnly: true };
    }
    return model;
  });
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
