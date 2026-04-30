import type {
  ProcessedModel,
  ShardDetection,
  ShardMetadataEntry,
} from "./types";

export function detectShardedModel(filename: string): ShardDetection {
  const shardPattern = /^(.+)-(\d{5})-of-(\d{5})(\.\w+)$/;
  const match = filename.match(shardPattern);

  if (match) {
    return {
      isSharded: true,
      baseFilename: match[1]!,
      currentShard: parseInt(match[2]!, 10),
      totalShards: parseInt(match[3]!, 10),
      extension: match[4]!,
    };
  }

  return { isSharded: false };
}

export function groupShardedModels(models: ProcessedModel[]): ProcessedModel[] {
  const shardGroups = new Map<string, ProcessedModel[]>();
  const nonShardedModels: ProcessedModel[] = [];

  for (const model of models) {
    if (model.isShardPart && model.shardInfo) {
      const baseKey = `${model.registrySource}:${model.shardInfo.baseFilename}`;
      if (!shardGroups.has(baseKey)) {
        shardGroups.set(baseKey, []);
      }
      shardGroups.get(baseKey)!.push(model);
    } else {
      nonShardedModels.push(model);
    }
  }

  const processedShards: ProcessedModel[] = [];
  for (const [baseKey, shards] of shardGroups) {
    shards.sort(
      (a, b) =>
        (a.shardInfo?.currentShard ?? 0) - (b.shardInfo?.currentShard ?? 0),
    );

    const firstShard = shards[0]!;
    const totalExpectedShards = firstShard.shardInfo?.totalShards ?? 0;

    if (shards.length !== totalExpectedShards) {
      console.warn(
        `⚠️  Expected ${totalExpectedShards} shards but found ${shards.length} for ${baseKey}`,
      );
    }

    const totalSize = shards.reduce((sum, s) => sum + s.expectedSize, 0);

    const shardMetadata: ShardMetadataEntry[] = shards.map((s) => ({
      filename: s.modelId,
      expectedSize: s.expectedSize,
      sha256Checksum: s.sha256Checksum,
      blobCoreKey: s.blobCoreKey,
      blobBlockOffset: s.blobBlockOffset,
      blobBlockLength: s.blobBlockLength,
      blobByteOffset: s.blobByteOffset,
    }));

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { isShardPart: _shard, shardInfo: _info, ...rest } = firstShard;
    processedShards.push({
      ...rest,
      expectedSize: totalSize,
      shardMetadata,
    });
  }

  return [...nonShardedModels, ...processedShards];
}
