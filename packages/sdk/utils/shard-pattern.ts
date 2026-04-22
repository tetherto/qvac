import { ModelLoadFailedError } from "./errors-server";
import type { ShardPatternInfo } from "@/schemas";

const SHARD_PATTERN = /^(.+)-(\d{5})-of-(\d{5})(\.\w+)$/;

/** Detect if `filename` matches the `<base>-NNNNN-of-NNNNN.<ext>` shard pattern. */
export function detectShardedModel(filename: string): ShardPatternInfo {
  const match = filename.match(SHARD_PATTERN);
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

/** Given any shard filename in a group, return all numbered shard filenames in order. */
export function generateShardFilenames(shardName: string): string[] {
  const info = detectShardedModel(shardName);
  if (!info.isSharded || !info.totalShards) {
    throw new ModelLoadFailedError(`Not a sharded model filename: ${shardName}`);
  }
  const { baseFilename, totalShards, extension } = info;
  const totalStr = totalShards.toString().padStart(5, "0");
  const filenames: string[] = [];
  for (let i = 1; i <= totalShards; i++) {
    filenames.push(`${baseFilename}-${i.toString().padStart(5, "0")}-of-${totalStr}${extension}`);
  }
  return filenames;
}
