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

export interface ShardMetadataEntry {
  filename: string;
  expectedSize: number;
  sha256Checksum: string;
  blobCoreKey: string;
  blobBlockOffset: number;
  blobBlockLength: number;
  blobByteOffset: number;
}

export interface ProcessedModel {
  registryPath: string;
  registrySource: string;
  blobCoreKey: string;
  blobBlockOffset: number;
  blobBlockLength: number;
  blobByteOffset: number;
  modelId: string;
  addon: ModelRegistryEntryAddon;
  expectedSize: number;
  sha256Checksum: string;
  engine: ModelRegistryEngine;
  modelName: string;
  quantization: string;
  params: string;
  tags: string[];
  isShardPart?: boolean;
  shardInfo?: ShardInfo;
  shardMetadata?: ShardMetadataEntry[];
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
