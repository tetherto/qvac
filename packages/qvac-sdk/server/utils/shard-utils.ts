import { ModelLoadFailedError } from "@/utils/errors-server";

export interface ShardInfo {
  isSharded: boolean;
  currentShard?: number;
  totalShards?: number;
  baseFilename?: string;
  extension?: string;
}

export interface ShardMetadata {
  filename: string;
  expectedSize: number;
  sha256Checksum: string;
}

/**
 * Detect if model filename follows shard pattern (00001-of-0000x)
 */
export function detectShardedModel(filename: string): ShardInfo {
  const shardPattern = /^(.+)-(\d{5})-of-(\d{5})(\.\w+)$/;
  const match = filename.match(shardPattern);

  if (match && match[1] && match[2] && match[3] && match[4]) {
    return {
      isSharded: true,
      baseFilename: match[1],
      currentShard: parseInt(match[2], 10),
      totalShards: parseInt(match[3], 10),
      extension: match[4],
    };
  }

  return { isSharded: false };
}

/**
 * Generate list of all required files for a sharded model
 * Includes numbered shards AND the .tensors.txt companion file
 */
export function generateShardFilenames(firstShardName: string): string[] {
  const shardInfo = detectShardedModel(firstShardName);

  if (!shardInfo.isSharded || !shardInfo.totalShards) {
    throw new ModelLoadFailedError(
      `Not a sharded model filename: ${firstShardName}`,
    );
  }

  const filenames: string[] = [];
  const { baseFilename, totalShards, extension } = shardInfo;

  for (let i = 1; i <= totalShards; i++) {
    const shardNumber = i.toString().padStart(5, "0");
    const totalShardsStr = totalShards.toString().padStart(5, "0");
    filenames.push(
      `${baseFilename}-${shardNumber}-of-${totalShardsStr}${extension}`,
    );
  }

  filenames.push(`${baseFilename}.tensors.txt`);
  return filenames;
}
