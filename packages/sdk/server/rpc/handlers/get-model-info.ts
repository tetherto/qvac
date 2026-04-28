import type {
  GetModelInfoRequest,
  GetModelInfoResponse,
  ModelInfo,
  LoadedInstance,
  CacheFileInfo,
} from "@/schemas";
import { models, type RegistryItem } from "@/models/registry/models";
import {
  getAllModelIds,
  getModelEntry,
} from "@/server/bare/registry/model-registry";
import { generateShortHash } from "@/server/utils";
import { promises as fsPromises } from "bare-fs";
import {
  getShardPath,
  getModelsCacheDir,
  getSingleFileCachePath,
} from "@/server/utils/cache/paths";
import { validateAndJoinPath } from "@/server/utils/path-security";
import { ModelNotFoundError } from "@/utils/errors-server";

type CacheStatusResult = {
  cacheFiles: CacheFileInfo[];
  isCached: boolean;
  actualSize?: number;
  cachedAt?: Date;
  primaryPath?: string | undefined;
};

export async function handleGetModelInfo(
  request: GetModelInfoRequest,
): Promise<GetModelInfoResponse> {
  const { name } = request;

  const catalogEntry: RegistryItem | undefined = models.find(
    (m) => m.name === name,
  );

  if (!catalogEntry) {
    throw new ModelNotFoundError(
      `${name}" not found in catalog. Use model names from the catalog (e.g., "WHISPER_TINY", "EMBEDDINGGEMMA_300M_Q4_0")`,
    );
  }

  const cacheKey = generateShortHash(catalogEntry.registryPath);

  const cacheStatus =
    catalogEntry.shardMetadata && catalogEntry.shardMetadata.length > 0
      ? await handleShardedModel(cacheKey, catalogEntry.shardMetadata)
      : catalogEntry.companionSet
        ? await handleCompanionSetModel(
            catalogEntry.companionSet,
            catalogEntry.registryPath,
          )
        : await handleSingleFileModel(
            catalogEntry.registryPath,
            catalogEntry.expectedSize,
            catalogEntry.sha256Checksum,
          );

  const { cacheFiles, isCached, actualSize, cachedAt, primaryPath } =
    cacheStatus;

  const loadedModelIds = getAllModelIds();
  const matchPath = primaryPath ?? cacheFiles[0]?.path;

  const loadedInstances: LoadedInstance[] = [];
  for (const id of loadedModelIds) {
    const entry = getModelEntry(id);
    if (!entry || entry.isDelegated) continue;

    const matchesByName = entry.local.name && entry.local.name === name;

    const matchesByPath = !!matchPath && entry.local.path === matchPath;

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

  const modelInfo: ModelInfo = {
    name: catalogEntry.name,
    modelId: catalogEntry.modelId,
    registryPath: catalogEntry.registryPath,
    registrySource: catalogEntry.registrySource,
    blobCoreKey: catalogEntry.blobCoreKey,
    blobBlockOffset: catalogEntry.blobBlockOffset,
    blobBlockLength: catalogEntry.blobBlockLength,
    blobByteOffset: catalogEntry.blobByteOffset,
    engine: catalogEntry.engine,
    quantization: catalogEntry.quantization,
    params: catalogEntry.params,
    expectedSize: catalogEntry.expectedSize,
    sha256Checksum: catalogEntry.sha256Checksum,
    addon: catalogEntry.addon,

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
  cacheKey: string,
  shardMetadata: readonly {
    filename: string;
    expectedSize: number;
    sha256Checksum: string;
    blobCoreKey?: string;
    blobIndex?: number;
  }[],
): Promise<CacheStatusResult> {
  const fileEntries = shardMetadata.map((s) => ({
    filename: s.filename,
    expectedSize: s.expectedSize,
    sha256Checksum: s.sha256Checksum,
  }));
  const paths = shardMetadata.map((s) => getShardPath(cacheKey, s.filename));
  return checkCacheStatus(fileEntries, paths);
}

async function handleCompanionSetModel(
  companionSet: NonNullable<RegistryItem["companionSet"]>,
  primaryRegistryPath: string,
): Promise<CacheStatusResult> {
  const { setKey, primaryKey, files } = companionSet;
  const baseCache = getModelsCacheDir();

  const fileEntries: CacheFileEntry[] = files.map((f) => ({
    filename: f.targetName,
    expectedSize: f.expectedSize,
    sha256Checksum: f.sha256Checksum,
    key: f.key,
  }));
  const canonicalPaths = files.map((f) =>
    validateAndJoinPath(baseCache, "sets", setKey, f.targetName),
  );

  const canonicalResult = await checkCacheStatus(
    fileEntries, canonicalPaths, primaryKey,
  );
  if (canonicalResult.isCached) return canonicalResult;

  const isOnnxSet = files.some(
    (f) => f.primary === true && f.targetName.endsWith(".onnx"),
  );
  if (isOnnxSet) {
    const legacyCacheKey = generateShortHash(primaryRegistryPath);
    const legacyPaths = files.map((f) =>
      validateAndJoinPath(baseCache, "onnx", legacyCacheKey, f.targetName),
    );
    const legacyResult = await checkCacheStatus(
      fileEntries, legacyPaths, primaryKey,
    );
    if (legacyResult.isCached) return legacyResult;
  } else {
    // Legacy flat-cache compatibility for Bergamot-style companion sets.
    // This is valid only for families whose runtime still works with explicit
    // per-file absolute paths; it is not a generic rule for all companion sets.
    const flatPaths = files.map((f) =>
      getSingleFileCachePath(f.registryPath),
    );
    const flatResult = await checkCacheStatus(
      fileEntries, flatPaths, primaryKey,
    );
    if (flatResult.isCached) return flatResult;
  }

  return canonicalResult;
}

type CacheFileEntry = {
  filename: string;
  expectedSize: number;
  sha256Checksum: string;
  key?: string;
};

async function checkCacheStatus(
  files: readonly CacheFileEntry[],
  paths: string[],
  primaryKey?: string,
): Promise<CacheStatusResult> {
  const cacheFiles: CacheFileInfo[] = [];
  let allCached = true;
  let totalActualSize = 0;
  let latestCachedAt: Date | undefined;
  let primaryPath: string | undefined;

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const filePath = paths[i]!;

    let fileCached = false;
    let fileActualSize: number | undefined;
    let fileCachedAt: Date | undefined;

    try {
      const stats = await fsPromises.stat(filePath);
      if (stats.isFile()) {
        fileActualSize = stats.size;
        fileCachedAt = stats.mtime;
        fileCached = stats.size === file.expectedSize;
      }
    } catch {
      // file does not exist
    }

    if (primaryKey && file.key === primaryKey) {
      primaryPath = filePath;
    }

    if (fileCached) {
      totalActualSize += fileActualSize!;
      if (!latestCachedAt || fileCachedAt! > latestCachedAt) {
        latestCachedAt = fileCachedAt;
      }
    } else {
      allCached = false;
    }

    cacheFiles.push({
      filename: file.filename,
      path: filePath,
      expectedSize: file.expectedSize,
      sha256Checksum: file.sha256Checksum,
      isCached: fileCached,
      actualSize: fileActualSize,
      cachedAt: fileCachedAt,
    });
  }

  if (!primaryPath && cacheFiles.length > 0) {
    primaryPath = cacheFiles[0]!.path;
  }

  const result: CacheStatusResult = {
    cacheFiles,
    isCached: allCached,
    primaryPath,
  };

  if (allCached) {
    result.actualSize = totalActualSize;
    if (latestCachedAt) {
      result.cachedAt = latestCachedAt;
    }
  }

  return result;
}

async function handleSingleFileModel(
  registryPath: string,
  expectedSize: number,
  sha256Checksum: string,
): Promise<CacheStatusResult> {
  const filename = registryPath.split("/").pop() || registryPath;
  const filePath = getSingleFileCachePath(registryPath);

  return checkCacheStatus(
    [{ filename, expectedSize, sha256Checksum }],
    [filePath],
  );
}
