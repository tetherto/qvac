import type {
  GetModelInfoRequest,
  GetModelInfoResponse,
  ModelInfo,
  LoadedInstance,
  CacheFileInfo,
} from "@/schemas";
import { models, type HyperdriveItem } from "@/models/hyperdrive/models";
import {
  getAllModelIds,
  getModelEntry,
} from "@/server/bare/registry/model-registry";
import { getConfiguredCacheDir } from "@/server/bare/registry/config-registry";
import { generateShortHash } from "@/server/utils";
import { promises as fsPromises } from "bare-fs";
import path from "bare-path";
import { getShardPath } from "@/server/utils/cache";
import { ModelNotFoundError } from "@/utils/errors-server";
import { normalizeModelType } from "@/schemas/model-types";

type CacheStatusResult = {
  cacheFiles: CacheFileInfo[];
  isCached: boolean;
  actualSize?: number;
  cachedAt?: Date;
};

export async function handleGetModelInfo(
  request: GetModelInfoRequest,
): Promise<GetModelInfoResponse> {
  const { name } = request;

  const catalogEntry: HyperdriveItem | undefined = models.find(
    (m) => m.name === name,
  );

  if (!catalogEntry) {
    throw new ModelNotFoundError(
      `${name}" not found in catalog. Use model names from the catalog (e.g., "WHISPER_TINY", "EMBEDDINGGEMMA_300M_Q4_0")`,
    );
  }

  const cacheStatus =
    catalogEntry.shardMetadata && catalogEntry.shardMetadata.length > 0
      ? await handleShardedModel(
          catalogEntry.hyperdriveKey,
          catalogEntry.shardMetadata,
        )
      : await handleSingleFileModel(
          catalogEntry.hyperdriveKey,
          catalogEntry.modelId,
          catalogEntry.expectedSize,
          catalogEntry.sha256Checksum,
        );

  const { cacheFiles, isCached, actualSize, cachedAt } = cacheStatus;

  const loadedModelIds = getAllModelIds();

  const loadedInstances: LoadedInstance[] = [];
  for (const id of loadedModelIds) {
    const entry = getModelEntry(id);
    if (!entry?.local) continue;

    const matchesByName = entry.local.name && entry.local.name === name;

    const matchesByPath =
      cacheFiles.length > 0 && entry.local.path === cacheFiles[0]?.path;

    if (matchesByName || matchesByPath) {
      const instance: LoadedInstance = {
        registryId: id,
        loadedAt: entry.local.loadedAt,
        config: entry.local.config,
      };

      loadedInstances.push(instance);
    }
  }

  const isLoaded = loadedInstances.length > 0;

  // Normalize addon from alias to canonical (vad passes through as-is)
  const normalizedAddon =
    catalogEntry.addon === "vad"
      ? ("vad" as const)
      : normalizeModelType(catalogEntry.addon);

  const modelInfo: ModelInfo = {
    name: catalogEntry.name,
    modelId: catalogEntry.modelId,
    hyperdriveKey: catalogEntry.hyperdriveKey,
    hyperbeeKey: catalogEntry.hyperbeeKey,
    expectedSize: catalogEntry.expectedSize,
    sha256Checksum: catalogEntry.sha256Checksum,
    addon: normalizedAddon,

    isCached,
    isLoaded,
    cacheFiles,

    actualSize,
    cachedAt,

    loadedInstances: loadedInstances.length > 0 ? loadedInstances : undefined,
  };

  return {
    type: "getModelInfo",
    modelInfo,
  };
}

async function handleShardedModel(
  hyperdriveKey: string,
  shardMetadata: readonly {
    filename: string;
    expectedSize: number;
    sha256Checksum: string;
  }[],
): Promise<CacheStatusResult> {
  const cacheFiles: CacheFileInfo[] = [];
  let allShardsCached = true;
  let totalActualSize = 0;
  let latestCachedAt: Date | undefined;

  for (const shard of shardMetadata) {
    const shardPath = getShardPath(hyperdriveKey, shard.filename);
    let shardIsCached = false;
    let shardActualSize: number | undefined;
    let shardCachedAt: Date | undefined;

    try {
      const stats = await fsPromises.stat(shardPath);
      const fileExists = stats.isFile();
      if (fileExists) {
        shardActualSize = stats.size;
        shardCachedAt = stats.mtime;
        shardIsCached = stats.size === shard.expectedSize;
        if (shardIsCached) {
          totalActualSize += stats.size;
          if (!latestCachedAt || stats.mtime > latestCachedAt) {
            latestCachedAt = stats.mtime;
          }
        } else {
          allShardsCached = false;
        }
      } else {
        allShardsCached = false;
      }
    } catch {
      shardIsCached = false;
      allShardsCached = false;
    }

    cacheFiles.push({
      filename: shard.filename,
      path: shardPath,
      expectedSize: shard.expectedSize,
      sha256Checksum: shard.sha256Checksum,
      isCached: shardIsCached,
      actualSize: shardActualSize,
      cachedAt: shardCachedAt,
    });
  }

  const result: CacheStatusResult = {
    cacheFiles,
    isCached: allShardsCached,
  };

  if (allShardsCached) {
    result.actualSize = totalActualSize;
    if (latestCachedAt) {
      result.cachedAt = latestCachedAt;
    }
  }

  return result;
}

async function handleSingleFileModel(
  hyperdriveKey: string,
  modelId: string,
  expectedSize: number,
  sha256Checksum: string,
): Promise<CacheStatusResult> {
  const cacheDir = getConfiguredCacheDir();
  const sourceHash = generateShortHash(`${hyperdriveKey}/${modelId}`);
  const filePath = path.join(cacheDir, `${sourceHash}_${modelId}`);

  let fileIsCached = false;
  let fileActualSize: number | undefined;
  let fileCachedAt: Date | undefined;

  try {
    const stats = await fsPromises.stat(filePath);
    const fileExists = stats.isFile();
    if (fileExists) {
      fileActualSize = stats.size;
      fileCachedAt = stats.mtime;
      fileIsCached = stats.size === expectedSize;
    }
  } catch {
    fileIsCached = false;
  }

  const cacheFiles: CacheFileInfo[] = [
    {
      filename: modelId,
      path: filePath,
      expectedSize,
      sha256Checksum,
      isCached: fileIsCached,
      actualSize: fileActualSize,
      cachedAt: fileCachedAt,
    },
  ];

  const result: CacheStatusResult = {
    cacheFiles,
    isCached: fileIsCached,
  };

  if (fileActualSize !== undefined) {
    result.actualSize = fileActualSize;
  }
  if (fileCachedAt !== undefined) {
    result.cachedAt = fileCachedAt;
  }

  return result;
}
