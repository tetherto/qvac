import fs, { promises as fsPromises } from "bare-fs";
import path from "bare-path";
import { getConfiguredCacheDir } from "@/server/bare/registry/config-registry";
import { getQvacPath } from "@/server/utils/qvac-paths";
import type { ShardFileMetadata } from "@/schemas";
import { calculateFileChecksum } from "@/server/utils/checksum";
import { validateAndJoinPath } from "@/server/utils/path-security";
import { generateShortHash } from "@/server/utils/formatting";
import { getServerLogger } from "@/logging";
import { nowMs } from "@/profiling";
import { resolveClearStorageTarget } from "@/server/utils/clear-storage";

const logger = getServerLogger();

export function getCacheDir(subDir: string): string {
  const cacheDir = getQvacPath(subDir);
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
 * Get cache directory for a companion set.
 * Returns: cache/sets/<setKey>/
 */
export function getCompanionSetCacheDir(setKey: string): string {
  const baseCache = getModelsCacheDir();
  const setDir = validateAndJoinPath(baseCache, "sets", setKey);

  try {
    fs.mkdirSync(setDir, { recursive: true });
  } catch (error) {
    logger.error(
      `Error creating companion set cache directory:`,
      error instanceof Error ? error.message : String(error),
    );
  }

  return setDir;
}

/**
 * Get full path to a file within a companion set cache.
 * Returns: cache/sets/<setKey>/<targetName>
 */
export function getCompanionSetPath(
  setKey: string,
  targetName: string,
): string {
  const setDir = getCompanionSetCacheDir(setKey);
  return validateAndJoinPath(setDir, targetName);
}

/**
 * Get cache path for a single (non-sharded, non-companion) registry model.
 */
export function getSingleFileCachePath(registryPath: string): string {
  const filename = registryPath.split("/").pop() || registryPath;
  const sourceHash = generateShortHash(registryPath);
  return path.join(getModelsCacheDir(), `${sourceHash}_${filename}`);
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
  return validateAndJoinPath(shardDir, shardFilename);
}

/**
 * Returns the deletion target for `clearStorage`. Scoped to the SDK cache
 * directory — companion set and legacy ONNX paths delete the parent directory.
 */
export function getClearStorageTarget(modelPath: string): {
  path: string;
  kind: "file" | "directory";
} {
  return resolveClearStorageTarget(modelPath, getModelsCacheDir());
}

/**
 * Check if all shards exist and are valid (size + checksum check)
 * Returns array of missing/invalid shard indices (0-based)
 * @param onChecksumTimeMs - Optional callback to report checksum validation time
 */
export async function checkShardCompleteness(
  hyperdriveKey: string,
  shardFilenames: readonly string[],
  shardMetadata: readonly ShardFileMetadata[],
  onChecksumTimeMs?: (ms: number) => void,
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
        const start = nowMs();
        const actualChecksum = await calculateFileChecksum(shardPath);
        onChecksumTimeMs?.(nowMs() - start);
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
