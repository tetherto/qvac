import type { ModelProgressUpdate, RegistryDownloadEntry } from "@/schemas";
import type { QVACModelEntry, QVACBlobBinding } from "@qvac/registry-client";
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
  getOnnxModelPath,
  calculateFileChecksum,
  extractTensorsFromShards,
  calculatePercentage,
} from "@/server/utils";
import { getModelByPath, type RegistryItem } from "@/models/registry";
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

const REGISTRY_STREAM_TIMEOUT_MS = 60_000;

function buildBlobBinding(meta: {
  blobCoreKey: string;
  blobBlockOffset: number;
  blobBlockLength: number;
  blobByteOffset: number;
  expectedSize: number;
}): QVACBlobBinding {
  return {
    coreKey: meta.blobCoreKey,
    blockOffset: meta.blobBlockOffset,
    blockLength: meta.blobBlockLength,
    byteOffset: meta.blobByteOffset,
    byteLength: meta.expectedSize,
  };
}

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

    // File exists but wrong size (incomplete/corrupted) - remove it
    logger.warn(
      `🗑️ Removing incomplete cached file (expected ${expectedSize}, got ${localSize}): ${modelPath}`,
    );
    await fsPromises.unlink(modelPath);
    return null;
  } catch (error) {
    if (error instanceof ChecksumValidationFailedError) {
      // Corrupted file - remove it so next download starts fresh
      logger.warn(`🗑️ Removing corrupted cached file: ${modelPath}`);
      await fsPromises.unlink(modelPath).catch(() => {});
    }
    // File doesn't exist or was cleaned up - need to download
    return null;
  }
}

/**
 * Download a single file from the registry to filesystem.
 * When blobBinding is provided, uses direct blob download (skips metadata sync).
 * Otherwise falls back to metadata-based downloadModel.
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
  blobBinding?: QVACBlobBinding,
): Promise<void> {
  if (signal?.aborted) {
    throw new DownloadCancelledError();
  }

  const client = await getRegistryClient();

  try {
    let readStream: Readable;

    if (blobBinding) {
      logger.info(`📥 Downloading blob directly: ${modelFileName}`);
      const result = await client.downloadBlob(blobBinding, { timeout: REGISTRY_STREAM_TIMEOUT_MS });
      if (!("stream" in result.artifact)) {
        throw new RegistryDownloadFailedError(
          `No stream returned for blob ${modelFileName}`,
        );
      }
      readStream = result.artifact.stream as unknown as Readable;
    } else {
      logger.info(`📥 Downloading from registry: ${registryPath}`);
      const result = await client.downloadModel(registryPath, registrySource, {
        timeout: REGISTRY_STREAM_TIMEOUT_MS,
      });
      if (!("stream" in result.artifact)) {
        throw new RegistryDownloadFailedError(
          `No stream returned for ${registryPath}`,
        );
      }
      readStream = result.artifact.stream as unknown as Readable;
    }

    const dir = path.dirname(modelPath);
    await fsPromises.mkdir(dir, { recursive: true });

    const writeStream = fs.createWriteStream(modelPath) as unknown as Writable;

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
      await fsPromises.unlink(modelPath).catch(() => {});
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
    await closeRegistryClient();
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

    // Use indexed path range query instead of fetching all models
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
        checksum:
          (s.blobBinding as unknown as Record<string, string>)?.["sha256"] ||
          s.sha256 ||
          "",
      }));

    logger.info(`📦 Found ${sortedShards.length} shards`);
    return sortedShards;
  } finally {
    await closeRegistryClient();
  }
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
): Promise<string> {
  if (signal?.aborted) {
    throw new DownloadCancelledError();
  }

  type ShardEntry = { filename: string; size: number; checksum: string; path: string; source: string; blobBinding?: QVACBlobBinding };
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
  const downloadKey = createRegistryDownloadKey(registryPath);

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

/**
 * Find companion ONNX data file in registry.
 * ONNX models with external data have a .onnx file and a .onnx_data file.
 */
function findOnnxCompanionDataFile(
  registryPath: string,
): RegistryItem | undefined {
  if (!registryPath.endsWith(".onnx")) return undefined;
  const dataPath = registryPath + "_data";
  return getModelByPath(dataPath);
}

/**
 * Download ONNX model with companion data file from registry.
 * Both files are placed in the same directory to satisfy ONNX Runtime requirements.
 * When blob bindings are provided, uses direct blob download (skips metadata sync).
 */
async function downloadOnnxWithDataFromRegistry(
  registryPath: string,
  registrySource: string,
  companionDataFile: RegistryItem,
  cacheKey: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  signal?: AbortSignal,
  mainBlobBinding?: QVACBlobBinding,
  dataBlobBinding?: QVACBlobBinding,
): Promise<string> {
  if (signal?.aborted) {
    throw new DownloadCancelledError();
  }

  const mainFilename = registryPath.split("/").pop() || registryPath;
  const dataFilename = companionDataFile.registryPath.split("/").pop() || "";
  const downloadKey = createRegistryDownloadKey(registryPath);

  const mainModelMetadata = getModelByPath(registryPath);
  const mainPath = getOnnxModelPath(cacheKey, mainFilename);
  const dataPath = getOnnxModelPath(cacheKey, dataFilename);

  logger.info(
    `📥 Downloading ONNX model with external data: ${mainFilename} + ${dataFilename}`,
  );

  const mainExpectedSize = mainModelMetadata?.expectedSize || 0;
  const mainChecksum = mainModelMetadata?.sha256Checksum || "";
  const dataExpectedSize = companionDataFile.expectedSize || 0;
  const dataChecksum = companionDataFile.sha256Checksum || "";

  const overallTotal = mainExpectedSize + dataExpectedSize;
  let overallDownloaded = 0;

  // Check if main file already cached
  const cachedMainPath = await validateCachedFile(
    mainPath,
    mainFilename,
    mainExpectedSize,
    mainChecksum,
  );

  if (cachedMainPath) {
    logger.info(`✅ Main ONNX file already cached: ${mainFilename}`);
    overallDownloaded += mainExpectedSize;
  } else {
    // Download main ONNX file
    const mainProgressCallback = progressCallback
      ? (progress: ModelProgressUpdate) => {
          const currentOverall = overallDownloaded + progress.downloaded;
          progressCallback({
            ...progress,
            downloadKey,
            onnxInfo: {
              currentFile: mainFilename,
              fileIndex: 1,
              totalFiles: 2,
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
      registryPath,
      registrySource,
      mainPath,
      mainFilename,
      downloadKey,
      mainExpectedSize,
      mainChecksum,
      mainProgressCallback,
      signal,
      mainBlobBinding,
    );

    overallDownloaded += mainExpectedSize;
    logger.info(`✅ Main ONNX file downloaded: ${mainFilename}`);
  }

  // Check if data file already cached
  const cachedDataPath = await validateCachedFile(
    dataPath,
    dataFilename,
    dataExpectedSize,
    dataChecksum,
  );

  if (cachedDataPath) {
    logger.info(`✅ ONNX data file already cached: ${dataFilename}`);
    overallDownloaded = overallTotal;
  } else {
    // Download companion data file
    const dataProgressCallback = progressCallback
      ? (progress: ModelProgressUpdate) => {
          const currentOverall = overallDownloaded + progress.downloaded;
          progressCallback({
            ...progress,
            downloadKey,
            onnxInfo: {
              currentFile: dataFilename,
              fileIndex: 2,
              totalFiles: 2,
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
      companionDataFile.registryPath,
      companionDataFile.registrySource,
      dataPath,
      dataFilename,
      downloadKey,
      dataExpectedSize,
      dataChecksum,
      dataProgressCallback,
      signal,
      dataBlobBinding,
    );

    logger.info(`✅ ONNX data file downloaded: ${dataFilename}`);
  }

  // Send final 100% progress
  if (progressCallback) {
    progressCallback({
      type: "modelProgress",
      downloaded: overallTotal,
      total: overallTotal,
      percentage: 100,
      downloadKey,
      onnxInfo: {
        currentFile: dataFilename,
        fileIndex: 2,
        totalFiles: 2,
        overallDownloaded: overallTotal,
        overallTotal,
        overallPercentage: 100,
      },
    });
  }

  return mainPath;
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
 * For known models (present in models.ts), uses direct blob download which
 * skips the registry metadata sync entirely. Falls back to metadata-based
 * download for unknown models.
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
        );
        if (!cached) {
          allCached = false;
          break;
        }
      }

      if (allCached) {
        const firstShardFilename = localShardMeta[0]!.filename;
        logger.info(`✅ All ${localShardMeta.length} shards cached`);

        if (progressCallback) {
          const overallTotal = localShardMeta.reduce(
            (sum, s) => sum + s.expectedSize,
            0,
          );
          progressCallback({
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
        }

        return getShardPath(cacheKey, firstShardFilename);
      }
    }

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
          localShardMeta,
        ),
      progressCallback,
    );
  }

  // Check for ONNX with companion data file
  const companionDataFile = findOnnxCompanionDataFile(registryPath);
  if (companionDataFile) {
    const cacheKey = generateShortHash(registryPath);

    // FS pre-check: if both files cached, return immediately
    const mainFilename = registryPath.split("/").pop() || registryPath;
    const dataFilename = companionDataFile.registryPath.split("/").pop() || "";
    const mainPath = getOnnxModelPath(cacheKey, mainFilename);
    const dataPath = getOnnxModelPath(cacheKey, dataFilename);

    const mainCached = await validateCachedFile(
      mainPath,
      mainFilename,
      modelMetadata?.expectedSize || 0,
      modelMetadata?.sha256Checksum,
    );
    const dataCached = await validateCachedFile(
      dataPath,
      dataFilename,
      companionDataFile.expectedSize,
      companionDataFile.sha256Checksum,
    );

    if (mainCached && dataCached) {
      logger.info(`✅ ONNX model and data file both cached`);

      if (progressCallback) {
        const total = (modelMetadata?.expectedSize || 0) + companionDataFile.expectedSize;
        progressCallback({
          type: "modelProgress",
          downloaded: total,
          total,
          percentage: 100,
          downloadKey,
          onnxInfo: {
            currentFile: dataFilename,
            fileIndex: 2,
            totalFiles: 2,
            overallDownloaded: total,
            overallTotal: total,
            overallPercentage: 100,
          },
        });
      }

      return mainCached;
    }

    const mainBlobBinding = modelMetadata ? buildBlobBinding(modelMetadata) : undefined;
    const dataBlobBinding = companionDataFile.blobCoreKey
      ? buildBlobBinding(companionDataFile)
      : undefined;

    return createManagedDownload(
      downloadKey,
      registryPath,
      (signal) =>
        downloadOnnxWithDataFromRegistry(
          registryPath,
          registrySource,
          companionDataFile,
          cacheKey,
          progressCallback,
          signal,
          mainBlobBinding,
          dataBlobBinding,
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

  const blobBinding = modelMetadata ? buildBlobBinding(modelMetadata) : undefined;

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
        blobBinding,
      );

      return modelPath;
    },
    progressCallback,
  );
}
