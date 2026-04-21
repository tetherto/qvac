import type {
  ModelRegistryEntryAddon,
  ModelRegistryEngine,
} from "../../schemas/registry";

export interface ShardInfo {
  isSharded: true;
  baseFilename: string;
  currentShard: number;
  totalShards: number;
  extension: string;
}

export interface NotSharded {
  isSharded: false;
}

export type ShardDetection = ShardInfo | NotSharded;

export interface BlobRef {
  expectedSize: number;
  sha256Checksum: string;
  blobCoreKey: string;
  blobBlockOffset: number;
  blobBlockLength: number;
  blobByteOffset: number;
}

export interface ShardMetadataEntry extends BlobRef {
  filename: string;
}

/**
 * A single file within a companion set (e.g., an `.onnx` model or its `_data` file).
 *
 * @property key - Identifier for this file within the set
 *   Used by plugins to look up resolved paths from the download artifacts.
 * @property targetName - Filename used when writing to the cache directory.
 * @property primary - When true, this is the main file whose resolved path is returned to
 *   the addon. Exactly one file per set should be primary.
 */
export interface CompanionSetMetadataEntry extends BlobRef {
  key: string;
  registryPath: string;
  registrySource: string;
  targetName: string;
  primary?: boolean;
}

/**
 * Describes a group of files that must be downloaded and cached together
 *
 * @property setKey - Deterministic hash identifying this set. Used as the cache
 *   subdirectory: `<cacheDir>/sets/<setKey>/`.
 * @property primaryKey - The `key` value of the primary file in the `files` array.
 *   The resolver returns this file's path to the addon after download.
 * @property files - All files in the set, including the primary.
 */
export interface CompanionSetMetadata {
  setKey: string;
  primaryKey: string;
  files: readonly CompanionSetMetadataEntry[];
}

export interface ProcessedModel extends BlobRef {
  registryPath: string;
  registrySource: string;
  modelId: string;
  addon: ModelRegistryEntryAddon;
  engine: ModelRegistryEngine;
  modelName: string;
  quantization: string;
  params: string;
  tags: string[];
  isShardPart?: boolean;
  shardInfo?: ShardInfo;
  shardMetadata?: ShardMetadataEntry[];
  companionSet?: CompanionSetMetadata;
  isCompanionOnly?: boolean;
  name?: string;
}

export interface CurrentModel {
  name: string;
  registryPath: string;
}

export interface CollectOptions {
  showDuplicates?: boolean;
  noDedup?: boolean;
}

export interface ExportNameInput {
  path: string;
  engine: ModelRegistryEngine;
  name: string;
  quantization: string;
  params: string;
  tags: string[];
  usedNames: Set<string>;
}
