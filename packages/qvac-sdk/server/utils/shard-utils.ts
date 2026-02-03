import {
  ModelLoadFailedError,
  InvalidShardUrlPatternError,
} from "@/utils/errors-server";
import { generateShortHash } from "./formatting";
import type { ShardPatternInfo, ShardUrl } from "@/schemas";
import { extractAndWriteTensorsFile } from "./gguf-tensor-extractor";
import { promises as fsPromises } from "bare-fs";
import path from "bare-path";

/**
 * Detect if model filename follows shard pattern (00001-of-0000x)
 */
export function detectShardedModel(filename: string): ShardPatternInfo {
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
 * Generate list of shard filenames for a sharded model
 * Accepts any shard in the group
 *
 * @param shardName - Any shard filename in the group (e.g., "model-00002-of-00005.gguf")
 * @returns Array of all numbered shard filenames
 */
export function generateShardFilenames(shardName: string): string[] {
  const shardInfo = detectShardedModel(shardName);

  if (!shardInfo.isSharded || !shardInfo.totalShards) {
    throw new ModelLoadFailedError(
      `Not a sharded model filename: ${shardName}`,
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

  return filenames;
}

/**
 * Parse pattern-based shard URL and generate all shard URLs with cache key
 * Works with patterns like: https://example.com/path/model-00002-of-00005.gguf
 *
 * @param shardUrl - Any shard URL in the group
 * @returns Object with shard URLs array and cache key
 */
export function parsePatternBasedShardUrl(shardUrl: string): {
  shardUrls: ShardUrl[];
  cacheKey: string;
} {
  const urlParts = shardUrl.split("/");
  const filename = urlParts[urlParts.length - 1]?.split("?")[0] || "";
  const shardInfo = detectShardedModel(filename);

  if (!shardInfo.isSharded || !shardInfo.baseFilename) {
    throw new InvalidShardUrlPatternError(shardUrl);
  }

  const shardFilenames = generateShardFilenames(filename);
  const baseUrl = urlParts.slice(0, -1).join("/");

  return {
    shardUrls: shardFilenames.map((shardFilename) => ({
      url: `${baseUrl}/${shardFilename}`,
      filename: shardFilename,
    })),
    cacheKey: generateShortHash(`${baseUrl}/${shardInfo.baseFilename}`),
  };
}

/**
 * Extract tensor information from all shards and write to baseFilename.tensors.txt
 * Required for sharded models to enable incremental/async loading
 * @param shardDir - Directory containing the shard files
 * @param shardFilename - Filename of any shard (e.g., "model-00001-of-00002.gguf")
 * @returns Path to the created tensors.txt file
 * @throws If not a sharded model or extraction fails
 */
export async function extractTensorsFromShards(
  shardDir: string,
  shardFilename: string,
): Promise<string> {
  const shardInfo = detectShardedModel(shardFilename);

  if (
    !shardInfo.isSharded ||
    !shardInfo.baseFilename ||
    !shardInfo.totalShards
  ) {
    throw new ModelLoadFailedError(
      `Not a sharded model filename: ${shardFilename}`,
    );
  }

  const allShardFilenames = generateShardFilenames(shardFilename);

  return extractAndWriteTensorsFile(
    shardDir,
    allShardFilenames,
    shardInfo.baseFilename,
  );
}

/**
 * Check if all numbered shard files exist
 * @param shardDir - Directory containing the shard files
 * @param shardFilename - Filename of any shard (e.g., "model-00001-of-00002.gguf")
 * @returns true if all numbered shards exist, false otherwise
 */
export async function checkAllShardsExist(
  shardDir: string,
  shardFilename: string,
) {
  const shardInfo = detectShardedModel(shardFilename);

  if (!shardInfo.isSharded) {
    return false;
  }

  const shardFilenames = generateShardFilenames(shardFilename);

  const allShardsExist = await Promise.all(
    shardFilenames.map((f) =>
      fsPromises
        .access(path.join(shardDir, f))
        .then(() => true)
        .catch(() => false),
    ),
  ).then((results) => results.every((exists) => exists));

  return allShardsExist;
}

/**
 * Validate that all shards and tensors.txt exist for a sharded model
 * @param shardDir - Directory containing the shard files
 * @param shardFilename - Filename of any shard (e.g., "model-00001-of-00002.gguf")
 * @returns true if all shards and tensors.txt exist, false otherwise
 */
export async function validateShardedModelCache(
  shardDir: string,
  shardFilename: string,
) {
  const shardInfo = detectShardedModel(shardFilename);

  if (!shardInfo.isSharded || !shardInfo.baseFilename) {
    return false;
  }

  const allShardsExist = await checkAllShardsExist(shardDir, shardFilename);

  if (!allShardsExist) {
    return false;
  }

  const tensorsFile = `${shardInfo.baseFilename}.tensors.txt`;
  const tensorsExist = await fsPromises
    .access(path.join(shardDir, tensorsFile))
    .then(() => true)
    .catch(() => false);

  return tensorsExist;
}
