import type { ModelRegistryEngine, ModelRegistryEntryAddon } from './schemas.ts'

export interface ShardInfo {
  isSharded: true
  baseFilename: string
  currentShard: number
  totalShards: number
  extension: string
}

export interface NotSharded {
  isSharded: false
}

export type ShardDetection = ShardInfo | NotSharded

export interface BlobRef {
  expectedSize: number
  sha256Checksum: string
  blobCoreKey: string
  blobBlockOffset: number
  blobBlockLength: number
  blobByteOffset: number
}

export interface ShardMetadataEntry extends BlobRef {
  filename: string
}

export interface CompanionSetMetadataEntry extends BlobRef {
  key: string
  registryPath: string
  registrySource: string
  targetName: string
  primary?: boolean
}

export interface CompanionSetMetadata {
  setKey: string
  primaryKey: string
  files: readonly CompanionSetMetadataEntry[]
}

export interface ProcessedModel extends BlobRef {
  registryPath: string
  registrySource: string
  modelId: string
  addon: ModelRegistryEntryAddon
  engine: ModelRegistryEngine
  modelName: string
  quantization: string
  params: string
  tags: string[]
  isShardPart?: boolean
  shardInfo?: ShardInfo
  shardMetadata?: ShardMetadataEntry[]
  companionSet?: CompanionSetMetadata
  isCompanionOnly?: boolean
  name?: string
}

export interface CurrentModel {
  name: string
  registryPath: string
}

export interface CollectOptions {
  showDuplicates?: boolean
  noDedup?: boolean
}

export interface ExportNameInput {
  path: string
  engine: ModelRegistryEngine
  name: string
  quantization: string
  params: string
  tags: string[]
  usedNames: Set<string>
}
