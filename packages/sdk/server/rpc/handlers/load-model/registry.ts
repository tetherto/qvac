import type { ModelProgressUpdate } from "@/schemas";
import type { QVACModelEntry, QVACBlobBinding } from "@qvac/registry-client";
import { promises as fsPromises } from "bare-fs";
import type { AbortSignal } from "bare-abort-controller";
import {
  generateShortHash,
  detectShardedModel,
  getShardedModelCacheDir,
  getShardPath,
  extractTensorsFromShards,
  calculatePercentage,
} from "@/server/utils";
import { getSingleFileCachePath } from "@/server/utils/cache";
import { getModelByPath, type RegistryItem } from "@/models/registry";
import { getRegistryClient } from "@/server/bare/registry/registry-client";
import {
  createRegistryDownloadKey,
  startOrJoinDownload,
  applyJoinedDownloadStats,
} from "@/server/rpc/handlers/load-model/download-manager";
import {
  buildBlobBinding,
  validateCachedFile,
  downloadSingleFileFromRegistry,
} from "@/server/rpc/handlers/load-model/registry-download-utils";
import { downloadCompanionSetFromRegistry } from "@/server/rpc/handlers/load-model/registry-companion-set";
import {
  DownloadCancelledError,
  ModelNotFoundError,
  RegistryDownloadFailedError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";
import type { DownloadHooks } from "./types";

const logger = getServerLogger();

/**
 * Find all shards for a model using path prefix query.
 */
async function findModelShards(
  registryPath: string,
): Promise<{ path: string; source: string; size: number; checksum: string }[]> {
  const client = await getRegistryClient();

  const shardInfo = detectShardedModel(registryPath.split("/").pop() || "");
  if (!shardInfo.isSharded) {
    throw new RegistryDownloadFailedError(`Not a sharded model path: ${registryPath}`);
  }

  const pathPrefix = registryPath.replace(/-\d{5}-of-\d{5}\./, ".");
  const basePath = pathPrefix.substring(0, pathPrefix.lastIndexOf("."));

  logger.info(`🔍 Finding shards with prefix: ${basePath}`);

  const shards: QVACModelEntry[] = await client.findModels({
    gte: { path: basePath },
    lte: { path: basePath + "\uffff" },
  });

  const sortedShards = shards
    .filter((s) => {
      const info = detectShardedModel(s.path.split("/").pop() || "");
      return info.isSharded;
    })
    .sort((a, b) => {
      const aInfo = detectShardedModel(a.path.split("/").pop() || "");
      const bInfo = detectShardedModel(b.path.split("/").pop() || "");
      return (aInfo.currentShard || 0) - (bInfo.currentShard || 0);
    })
    .map((s) => ({
      path: s.path,
      source: s.source,
      size: s.blobBinding?.byteLength || 0,
      checksum:
        (s.blobBinding as unknown as Record<string, string>)?.["sha256"] ||
        s.sha256 ||
        "",
    }));

  logger.info(`📦 Found ${sortedShards.length} shards`);
  return sortedShards;
}

/**
 * Download sharded model files from registry.
 * When localShardMetadata is provided, uses pre-computed metadata + blob direct download
 * instead of querying the registry for shard info.
 */
async function downloadShardedFilesFromRegistry(
  registryPath: string,
  registrySource: string,
  cacheKey: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  signal?: AbortSignal,
  localShardMetadata?: RegistryItem["shardMetadata"],
  hooks?: DownloadHooks,
): Promise<string> {
  if (signal?.aborted) {
    throw new DownloadCancelledError();
  }

  type ShardEntry = {
    filename: string;
    size: number;
    checksum: string;
    path: string;
    source: string;
    blobBinding?: QVACBlobBinding;
  };
  let shards: ShardEntry[];

  if (localShardMetadata?.length) {
    shards = localShardMetadata.map((shard) => ({
      filename: shard.filename,
      size: shard.expectedSize,
      checksum: shard.sha256Checksum,
      path: registryPath,
      source: registrySource,
      blobBinding: buildBlobBinding(shard),
    }));
  } else {
    const filename = registryPath.split("/").pop() || registryPath;
    const shardInfo = detectShardedModel(filename);
    if (!shardInfo.isSharded || !shardInfo.totalShards) {
      throw new RegistryDownloadFailedError(`Not a sharded model: ${filename}`);
    }

    const remoteShards = await findModelShards(registryPath);

    if (remoteShards.length === 0) {
      throw new ModelNotFoundError(`No shards found for ${registryPath}`);
    }

    if (remoteShards.length !== shardInfo.totalShards) {
      logger.warn(
        `⚠️ Expected ${shardInfo.totalShards} shards but found ${remoteShards.length}`,
      );
    }

    shards = remoteShards.map((s) => ({
      filename: s.path.split("/").pop() || "",
      size: s.size,
      checksum: s.checksum,
      path: s.path,
      source: s.source,
    }));
  }

  const shardDir = getShardedModelCacheDir(cacheKey);
  const downloadKey = createRegistryDownloadKey(registrySource, registryPath);

  logger.info(
    `📥 Downloading sharded model: ${shards.length} shards to ${shardDir}`,
  );

  const overallTotal = shards.reduce((sum, s) => sum + s.size, 0);
  let overallDownloaded = 0;

  for (let i = 0; i < shards.length; i++) {
    if (signal?.aborted) {
      throw new DownloadCancelledError();
    }

    const shard = shards[i]!;
    const shardPath = getShardPath(cacheKey, shard.filename);

    const cachedPath = await validateCachedFile(
      shardPath,
      shard.filename,
      shard.size,
      shard.checksum,
      hooks,
    );

    if (cachedPath) {
      logger.debug(`✅ Shard ${i + 1}/${shards.length} already cached`);
      overallDownloaded += shard.size;

      if (progressCallback) {
        progressCallback({
          type: "modelProgress",
          downloaded: shard.size,
          total: shard.size,
          percentage: 100,
          downloadKey,
          shardInfo: {
            currentShard: i + 1,
            totalShards: shards.length,
            shardName: shard.filename,
            overallDownloaded,
            overallTotal,
            overallPercentage: calculatePercentage(
              overallDownloaded,
              overallTotal,
            ),
          },
        });
      }
      continue;
    }

    logger.info(
      `📥 Downloading shard ${i + 1}/${shards.length}: ${shard.filename}`,
    );

    const shardProgressCallback = progressCallback
      ? (progress: ModelProgressUpdate) => {
          const currentOverall = overallDownloaded + progress.downloaded;
          progressCallback({
            ...progress,
            downloadKey,
            shardInfo: {
              currentShard: i + 1,
              totalShards: shards.length,
              shardName: shard.filename,
              overallDownloaded: currentOverall,
              overallTotal,
              overallPercentage: calculatePercentage(
                currentOverall,
                overallTotal,
              ),
            },
          });
        }
      : undefined;

    await downloadSingleFileFromRegistry(
      shard.path,
      shard.source,
      shardPath,
      shard.filename,
      downloadKey,
      shard.size,
      shard.checksum,
      shardProgressCallback,
      signal,
      shard.blobBinding,
      hooks,
    );

    overallDownloaded += shard.size;
    logger.info(`✅ Shard ${i + 1}/${shards.length} downloaded`);
  }

  const firstShardFilename = shards[0]!.filename;
  await extractTensorsFromShards(shardDir, firstShardFilename);

  if (progressCallback) {
    const lastShard = shards[shards.length - 1]!;
    progressCallback({
      type: "modelProgress",
      downloaded: overallTotal,
      total: overallTotal,
      percentage: 100,
      downloadKey,
      shardInfo: {
        currentShard: shards.length,
        totalShards: shards.length,
        shardName: lastShard.filename,
        overallDownloaded: overallTotal,
        overallTotal,
        overallPercentage: 100,
      },
    });
  }

  return getShardPath(cacheKey, firstShardFilename);
}

export async function downloadModelFromRegistry(
  registryPath: string,
  registrySource: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  expectedChecksum?: string,
  hooks?: DownloadHooks,
): Promise<string> {
  const downloadKey = createRegistryDownloadKey(registrySource, registryPath);
  hooks?.onDownloadKey?.(downloadKey);
  const filename = registryPath.split("/").pop() || registryPath;
  const shardInfo = detectShardedModel(filename);

  // Look up model metadata from our generated models.ts
  const modelMetadata = getModelByPath(registryPath);

  const result = startOrJoinDownload(
    downloadKey,
    async (ctx) => {
      if (shardInfo.isSharded) {
        const cacheKey = generateShortHash(registryPath);
        const localShardMeta = modelMetadata?.shardMetadata;

        // FS pre-check for known models: if all shards cached, return immediately
        if (localShardMeta?.length) {
          let allCached = true;
          for (const shard of localShardMeta) {
            const shardPath = getShardPath(cacheKey, shard.filename);
            const cached = await validateCachedFile(
              shardPath,
              shard.filename,
              shard.expectedSize,
              shard.sha256Checksum,
              hooks,
            );
            if (!cached) {
              allCached = false;
              break;
            }
          }

          if (allCached) {
            const firstShardFilename = localShardMeta[0]!.filename;
            logger.info(`✅ All ${localShardMeta.length} shards cached`);
            hooks?.markCacheHit?.();
            ctx.setCacheHit(true);

            const overallTotal = localShardMeta.reduce(
              (sum, s) => sum + s.expectedSize,
              0,
            );
            ctx.broadcastProgress({
              type: "modelProgress",
              downloaded: overallTotal,
              total: overallTotal,
              percentage: 100,
              downloadKey,
              shardInfo: {
                currentShard: localShardMeta.length,
                totalShards: localShardMeta.length,
                shardName: firstShardFilename,
                overallDownloaded: overallTotal,
                overallTotal,
                overallPercentage: 100,
              },
            });

            return getShardPath(cacheKey, firstShardFilename);
          }
        }

        hooks?.markCacheMiss?.();
        ctx.setCacheHit(false);
        try {
          return await downloadShardedFilesFromRegistry(
            registryPath,
            registrySource,
            cacheKey,
            ctx.broadcastProgress,
            ctx.signal,
            localShardMeta,
            hooks,
          );
        } catch (error) {
          if (
            error instanceof DownloadCancelledError &&
            ctx.shouldClearCache()
          ) {
            try {
              await fsPromises.rm(getShardedModelCacheDir(cacheKey), {
                recursive: true,
                force: true,
              });
            } catch (cleanupError) {
              logger.debug("Failed to delete shard cache dir during cleanup", {
                cacheKey,
                error: cleanupError,
              });
            }
          }
          throw error;
        }
      }

      // Generic companion set via generated metadata
      if (modelMetadata?.companionSet) {
        const companionHooks: DownloadHooks = {
          ...hooks,
          markCacheHit: () => {
            hooks?.markCacheHit?.();
            ctx.setCacheHit(true);
          },
          markCacheMiss: () => {
            hooks?.markCacheMiss?.();
            ctx.setCacheHit(false);
          },
        };

        return await downloadCompanionSetFromRegistry({
          companionSet: modelMetadata.companionSet,
          downloadKey,
          progressCallback: ctx.broadcastProgress,
          signal: ctx.signal,
          hooks: companionHooks,
          shouldClearCache: ctx.shouldClearCache,
        });
      }

      const modelPath = getSingleFileCachePath(registryPath);

      const expectedSize = modelMetadata?.expectedSize || 0;
      const checksum =
        expectedChecksum || modelMetadata?.sha256Checksum || "";

      const cachedPath = await validateCachedFile(
        modelPath,
        filename,
        expectedSize,
        checksum,
        hooks,
      );

      if (cachedPath) {
        logger.info(`✅ Using cached model: ${cachedPath}`);
        hooks?.markCacheHit?.();
        ctx.setCacheHit(true);

        ctx.broadcastProgress({
          type: "modelProgress",
          downloaded: expectedSize,
          total: expectedSize,
          percentage: 100,
          downloadKey,
        });

        return cachedPath;
      }

      const blobBinding = modelMetadata
        ? buildBlobBinding(modelMetadata)
        : undefined;

      hooks?.markCacheMiss?.();
      ctx.setCacheHit(false);
      try {
        await downloadSingleFileFromRegistry(
          registryPath,
          registrySource,
          modelPath,
          filename,
          downloadKey,
          expectedSize,
          checksum,
          ctx.broadcastProgress,
          ctx.signal,
          blobBinding,
          hooks,
        );
      } catch (error) {
        if (
          error instanceof DownloadCancelledError &&
          ctx.shouldClearCache()
        ) {
          try {
            await fsPromises.unlink(modelPath);
          } catch (cleanupError) {
            logger.debug("Failed to delete model file during cleanup", {
              path: modelPath,
              error: cleanupError,
            });
          }
        }
        throw error;
      }

      return modelPath;
    },
    progressCallback,
  );

  return applyJoinedDownloadStats(result, hooks);
}
