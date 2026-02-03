import fs, { promises as fsPromises } from "bare-fs";
import path from "bare-path";
import { getEnv } from "@/server/worker";
import { getConfiguredCacheDir } from "@/server/bare/registry/config-registry";
import type { ShardFileMetadata } from "@/schemas";
import { calculateFileChecksum } from "@/server/utils/checksum";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export function getCacheDir(subDir: string): string {
  const homeDir = getEnv().HOME_DIR;
  const cacheDir = path.join(homeDir, ".qvac", subDir);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch (error) {
    logger.error(
      `Error creating cache directory (${subDir}):`,
      error instanceof Error ? error.message : String(error),
    );
  }

  return cacheDir;
}

export function getModelsCacheDir(): string {
  const configuredDir = getConfiguredCacheDir();

  try {
    fs.mkdirSync(configuredDir, { recursive: true });
  } catch (error) {
    logger.error(
      `Error creating models cache directory:`,
      error instanceof Error ? error.message : String(error),
    );
  }

  return configuredDir;
}

export function getKVCacheDir(): string {
  return getCacheDir("kv-cache");
}

/**
 * Get cache directory for sharded model
 * Returns: cache/sharded/<hyperdriveKey>/
 */
export function getShardedModelCacheDir(hyperdriveKey: string): string {
  const baseCache = getModelsCacheDir();
  const shardDir = path.join(baseCache, "sharded", hyperdriveKey);

  try {
    fs.mkdirSync(shardDir, { recursive: true });
  } catch (error) {
    logger.error(
      `Error creating sharded model cache directory:`,
      error instanceof Error ? error.message : String(error),
    );
  }

  return shardDir;
}

/**
 * Get full path to specific shard file
 * Returns: cache/sharded/<hyperdriveKey>/<shardFilename>
 */
export function getShardPath(
  hyperdriveKey: string,
  shardFilename: string,
): string {
  const shardDir = getShardedModelCacheDir(hyperdriveKey);
  return path.join(shardDir, shardFilename);
}

/**
 * Check if all shards exist and are valid (size + checksum check)
 * Returns array of missing/invalid shard indices (0-based)
 */
export async function checkShardCompleteness(
  hyperdriveKey: string,
  shardFilenames: readonly string[],
  shardMetadata: readonly ShardFileMetadata[],
): Promise<number[]> {
  const invalidIndices: number[] = [];

  for (let i = 0; i < shardFilenames.length; i++) {
    const shardPath = getShardPath(hyperdriveKey, shardFilenames[i]!);
    const fileMeta = shardMetadata[i];

    if (!fileMeta) {
      invalidIndices.push(i);
      continue;
    }

    try {
      const stats = await fsPromises.stat(shardPath);
      if (stats.size !== fileMeta.expectedSize) {
        logger.warn(
          `File ${i + 1} size mismatch: expected ${fileMeta.expectedSize}, got ${stats.size}`,
        );
        invalidIndices.push(i);
        continue;
      }

      if (fileMeta.sha256Checksum) {
        const actualChecksum = await calculateFileChecksum(shardPath);
        if (actualChecksum !== fileMeta.sha256Checksum) {
          logger.warn(
            `File ${i + 1} checksum mismatch for ${fileMeta.filename}. Expected: ${fileMeta.sha256Checksum}. Actual: ${actualChecksum}. Will re-download.`,
          );
          invalidIndices.push(i);
        }
      }
    } catch {
      // File doesn't exist
      invalidIndices.push(i);
    }
  }

  return invalidIndices;
}
