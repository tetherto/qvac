import type { ModelProgressUpdate, RegistryDownloadEntry } from "@/schemas";
import type { QVACModelEntry } from "@tetherto/qvac-lib-registry-client";
import fs, { promises as fsPromises } from "bare-fs";
import path from "bare-path";
import { type Readable, type Writable } from "bare-stream";
import { AbortController, type AbortSignal } from "bare-abort-controller";
import {
  getModelsCacheDir,
  generateShortHash,
  detectShardedModel,
  getShardedModelCacheDir,
  getShardPath,
  calculateFileChecksum,
  extractTensorsFromShards,
  calculatePercentage,
} from "@/server/utils";
import { getModelByPath } from "@/models/hyperdrive";
import {
  getRegistryClient,
  closeRegistryClient,
} from "@/server/bare/registry/registry-client";
import {
  getActiveDownload,
  registerDownload,
  unregisterDownload,
  createRegistryDownloadKey,
  clearClearCacheFlag,
} from "@/server/rpc/handlers/load-model/download-manager";
import {
  ChecksumValidationFailedError,
  DownloadCancelledError,
  ModelNotFoundError,
  RegistryDownloadFailedError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

/**
 * Validate a cached file against expected size and checksum.
 */
async function validateCachedFile(
  modelPath: string,
  modelFileName: string,
  expectedSize: number,
  expectedChecksum?: string,
): Promise<string | null> {
  try {
    await fsPromises.access(modelPath);

    const localStats = await fsPromises.stat(modelPath);
    const localSize = localStats.size;

    if (localSize === expectedSize) {
      logger.info(`✅ Model cached with correct size: ${modelPath}`);

      // Validate checksum if provided
      if (expectedChecksum && expectedChecksum.length === 64) {
        const checksum = await calculateFileChecksum(modelPath);
        if (checksum !== expectedChecksum) {
          throw new ChecksumValidationFailedError(
            `${modelFileName}. Expected: ${expectedChecksum}. Actual: ${checksum}. File may be corrupted`,
          );
        }
      }
      logger.info(`✅ Model already cached and validated: ${modelPath}`);
      return modelPath;
    }

    // File exists but incomplete
    return null;
  } catch {
    // Model doesn't exist, need to download
    return null;
  }
}

/**
 * Download a single file from the registry to filesystem.
 */
async function downloadSingleFileFromRegistry(
  registryPath: string,
  registrySource: string,
  modelPath: string,
  modelFileName: string,
  downloadKey: string,
  expectedSize: number,
  expectedChecksum: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new DownloadCancelledError();
  }

  logger.info(`📥 Downloading from registry: ${registryPath}`);

  const client = await getRegistryClient();

  try {
    // Download using the registry client
    const result = await client.downloadModel(registryPath, registrySource, {
      timeout: 300000, // 5 minute timeout
    });

    // Check if we got a stream (not a file path)
    if (!("stream" in result.artifact)) {
      throw new RegistryDownloadFailedError(
        `No stream returned for ${registryPath}`,
      );
    }

    // Ensure directory exists
    const dir = path.dirname(modelPath);
    await fsPromises.mkdir(dir, { recursive: true });

    // Create write stream
    const writeStream = fs.createWriteStream(modelPath) as unknown as Writable;
    const readStream = result.artifact.stream as unknown as Readable;

    // Track progress
    let downloadedBytes = 0;

    readStream.on("data", (chunk: unknown) => {
      const buffer = chunk as Buffer;
      downloadedBytes += buffer.length;

      if (progressCallback) {
        progressCallback({
          type: "modelProgress",
          downloaded: downloadedBytes,
          total: expectedSize || downloadedBytes,
          percentage: expectedSize
            ? calculatePercentage(downloadedBytes, expectedSize)
            : 0,
          downloadKey,
        });
      }
    });

    // Pipe stream to file
    readStream.pipe(writeStream);

    // Wait for download to complete
    await new Promise<void>((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
      readStream.on("error", reject);

      signal?.addEventListener(
        "abort",
        () => reject(new Error("Download cancelled")),
        { once: true },
      );
    });

    logger.info(`✅ Downloaded to ${modelPath}`);

    // Validate file size
    const stats = await fsPromises.stat(modelPath);
    if (expectedSize && stats.size !== expectedSize) {
      throw new ChecksumValidationFailedError(
        `${modelFileName}. File size mismatch: expected ${expectedSize}, got ${stats.size}`,
      );
    }

    // Validate checksum
    if (expectedChecksum && expectedChecksum.length === 64) {
      const checksum = await calculateFileChecksum(modelPath);
      if (checksum !== expectedChecksum) {
        await fsPromises.unlink(modelPath);
        throw new ChecksumValidationFailedError(
          `${modelFileName}. Expected: ${expectedChecksum}. Actual: ${checksum}`,
        );
      }
      logger.info(`✅ Checksum validated for ${modelFileName}`);
    }

    // Send final 100% progress
    if (progressCallback) {
      progressCallback({
        type: "modelProgress",
        downloaded: stats.size,
        total: stats.size,
        percentage: 100,
        downloadKey,
      });
    }
  } finally {
    void closeRegistryClient();
  }
}

/**
 * Find all shards for a model using path prefix query.
 */
async function findModelShards(
  registryPath: string,
): Promise<{ path: string; source: string; size: number; checksum: string }[]> {
  const client = await getRegistryClient();

  try {
    // Extract the base path without the shard suffix
    const shardInfo = detectShardedModel(registryPath.split("/").pop() || "");
    if (!shardInfo.isSharded) {
      throw new Error(`Not a sharded model path: ${registryPath}`);
    }

    // Get path prefix by removing the shard suffix
    const pathPrefix = registryPath.replace(/-\d{5}-of-\d{5}\./, ".");
    const basePath = pathPrefix.substring(0, pathPrefix.lastIndexOf("."));

    logger.info(`🔍 Finding shards with prefix: ${basePath}`);

    // Query registry for all shards
    const shards: QVACModelEntry[] = await client.findModels({
      gte: { path: basePath },
      lte: { path: basePath + "\uffff" },
    });

    // Sort shards by shard number
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
        checksum: s.sha256 || "",
      }));

    logger.info(`📦 Found ${sortedShards.length} shards`);
    return sortedShards;
  } finally {
    void closeRegistryClient();
  }
}

/**
 * Download sharded model files from registry.
 */
async function downloadShardedFilesFromRegistry(
  registryPath: string,
  _registrySource: string,
  cacheKey: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    throw new DownloadCancelledError();
  }

  const filename = registryPath.split("/").pop() || registryPath;
  const shardInfo = detectShardedModel(filename);
  if (!shardInfo.isSharded || !shardInfo.totalShards) {
    throw new RegistryDownloadFailedError(`Not a sharded model: ${filename}`);
  }

  // Find all shards from registry
  const shards = await findModelShards(registryPath);

  if (shards.length === 0) {
    throw new ModelNotFoundError(`No shards found for ${registryPath}`);
  }

  if (shards.length !== shardInfo.totalShards) {
    logger.warn(
      `⚠️ Expected ${shardInfo.totalShards} shards but found ${shards.length}`,
    );
  }

  const shardDir = getShardedModelCacheDir(cacheKey);
  const downloadKey = createRegistryDownloadKey(registryPath);

  logger.info(
    `📥 Downloading sharded model: ${shards.length} shards to ${shardDir}`,
  );

  // Calculate overall progress
  const overallTotal = shards.reduce((sum, s) => sum + s.size, 0);
  let overallDownloaded = 0;

  // Download each shard
  for (let i = 0; i < shards.length; i++) {
    if (signal?.aborted) {
      throw new DownloadCancelledError();
    }

    const shard = shards[i]!;
    const shardFilename = shard.path.split("/").pop() || `shard-${i}`;
    const shardPath = getShardPath(cacheKey, shardFilename);

    // Check if shard already exists and is valid
    const cachedPath = await validateCachedFile(
      shardPath,
      shardFilename,
      shard.size,
      shard.checksum,
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
            shardName: shardFilename,
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
      `📥 Downloading shard ${i + 1}/${shards.length}: ${shardFilename}`,
    );

    // Create progress callback for this shard
    const shardProgressCallback = progressCallback
      ? (progress: ModelProgressUpdate) => {
          const currentOverall = overallDownloaded + progress.downloaded;
          progressCallback({
            ...progress,
            downloadKey,
            shardInfo: {
              currentShard: i + 1,
              totalShards: shards.length,
              shardName: shardFilename,
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
      shardFilename,
      downloadKey,
      shard.size,
      shard.checksum,
      shardProgressCallback,
      signal,
    );

    overallDownloaded += shard.size;
    logger.info(`✅ Shard ${i + 1}/${shards.length} downloaded`);
  }

  // Extract tensors if needed
  const firstShardFilename = shards[0]!.path.split("/").pop() || "";
  await extractTensorsFromShards(shardDir, firstShardFilename);

  // Send final 100% progress
  if (progressCallback) {
    const lastShard = shards[shards.length - 1]!;
    const lastShardFilename = lastShard.path.split("/").pop() || "";
    progressCallback({
      type: "modelProgress",
      downloaded: overallTotal,
      total: overallTotal,
      percentage: 100,
      downloadKey,
      shardInfo: {
        currentShard: shards.length,
        totalShards: shards.length,
        shardName: lastShardFilename,
        overallDownloaded: overallTotal,
        overallTotal,
        overallPercentage: 100,
      },
    });
  }

  return getShardPath(cacheKey, firstShardFilename);
}

/**
 * Create a managed download with abort controller support.
 */
function createManagedDownload(
  downloadKey: string,
  registryPath: string,
  downloadFn: (signal: AbortSignal) => Promise<string>,
  progressCallback?: (progress: ModelProgressUpdate) => void,
): Promise<string> {
  const abortController = new AbortController();

  const downloadPromise = (async () => {
    try {
      return await downloadFn(abortController.signal);
    } finally {
      unregisterDownload(downloadKey);
      clearClearCacheFlag(downloadKey);
    }
  })();

  const downloadEntry: RegistryDownloadEntry = {
    key: downloadKey,
    promise: downloadPromise,
    abortController,
    startTime: Date.now(),
    type: "registry",
    registryPath,
    ...(progressCallback && { onProgress: progressCallback }),
  };

  registerDownload(downloadKey, downloadEntry);
  return downloadPromise;
}

/**
 * Download a model from the QVAC Registry.
 *
 * @param registryPath - The registry path (e.g., "hf/repo/blob/hash/model.gguf")
 * @param registrySource - The source identifier (e.g., "hf")
 * @param progressCallback - Optional callback for progress updates
 * @param expectedChecksum - Optional checksum for validation
 */
export async function downloadModelFromRegistry(
  registryPath: string,
  registrySource: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  expectedChecksum?: string,
): Promise<string> {
  const downloadKey = createRegistryDownloadKey(registryPath);

  // Check if already downloading
  const existing = getActiveDownload(downloadKey);
  if (existing) {
    logger.info(`📥 Reusing existing download for: ${downloadKey}`);
    return existing.promise;
  }

  const filename = registryPath.split("/").pop() || registryPath;
  const shardInfo = detectShardedModel(filename);

  // Look up model metadata from our generated models.ts
  const modelMetadata = getModelByPath(registryPath);

  if (shardInfo.isSharded) {
    // Sharded model download
    const cacheKey = generateShortHash(registryPath);

    return createManagedDownload(
      downloadKey,
      registryPath,
      (signal) =>
        downloadShardedFilesFromRegistry(
          registryPath,
          registrySource,
          cacheKey,
          progressCallback,
          signal,
        ),
      progressCallback,
    );
  }

  // Single file download
  const cacheDir = getModelsCacheDir();
  const sourceHash = generateShortHash(registryPath);
  const modelPath = path.join(cacheDir, `${sourceHash}_${filename}`);

  // Check if already cached
  const expectedSize = modelMetadata?.expectedSize || 0;
  const checksum = expectedChecksum || modelMetadata?.sha256Checksum || "";

  const cachedPath = await validateCachedFile(
    modelPath,
    filename,
    expectedSize,
    checksum,
  );

  if (cachedPath) {
    logger.info(`✅ Using cached model: ${cachedPath}`);

    if (progressCallback) {
      progressCallback({
        type: "modelProgress",
        downloaded: expectedSize,
        total: expectedSize,
        percentage: 100,
        downloadKey,
      });
    }

    return cachedPath;
  }

  // Download from registry
  return createManagedDownload(
    downloadKey,
    registryPath,
    async (signal) => {
      await downloadSingleFileFromRegistry(
        registryPath,
        registrySource,
        modelPath,
        filename,
        downloadKey,
        expectedSize,
        checksum,
        progressCallback,
        signal,
      );

      return modelPath;
    },
    progressCallback,
  );
}
