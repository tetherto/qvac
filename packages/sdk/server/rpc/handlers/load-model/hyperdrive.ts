import type { ModelProgressUpdate, ShardFileMetadata } from "@/schemas";
import fs, { promises as fsPromises } from "bare-fs";
import path from "bare-path";
import Corestore from "corestore";
import Hyperswarm, { type Connection } from "hyperswarm";
import Hyperdrive from "hyperdrive";
import type { Entry } from "hyperdrive";
import { type Readable, type Writable } from "bare-stream";
import type { AbortSignal } from "bare-abort-controller";
import { getQvacPath } from "@/server/utils/qvac-paths";
import {
  getModelsCacheDir,
  generateShortHash,
  detectShardedModel,
  getShardedModelCacheDir,
  getShardPath,
  checkShardCompleteness,
  measureChecksum,
  extractTensorsFromShards,
  calculatePercentage,
} from "@/server/utils";
import { getModelBySrc } from "@/models/registry";
import {
  createHyperdriveDownloadKey,
  startOrJoinDownload,
  applyJoinedDownloadStats,
} from "@/server/rpc/handlers/load-model/download-manager";
import { getSDKConfig } from "@/server/bare/registry/config-registry";
import {
  FileNotFoundError,
  ChecksumValidationFailedError,
  DownloadCancelledError,
  HyperdriveDownloadFailedError,
  ModelLoadFailedError,
  NoBlobFoundError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";
import {
  registerSwarm,
  unregisterSwarm,
  registerCorestore,
  unregisterCorestore,
} from "@/server/bare/runtime-lifecycle";
import type { DownloadHooks } from "./types";

const logger = getServerLogger();

interface HyperdriveSetup {
  corestore: Corestore;
  drive: Hyperdrive;
  swarm: Hyperswarm;
  corestoreDir: string;
}

interface ProgressContext {
  downloadKey: string;
  callback: (progress: ModelProgressUpdate) => void;
  shardInfo?: {
    currentShard: number;
    totalShards: number;
    shardName: string;
    overallDownloaded: number;
    overallTotal: number;
  };
}

function getCorestoreDir(hyperdriveKey: string): string {
  return getQvacPath("corestore", hyperdriveKey);
}

async function setupHyperdrive(
  hyperdriveKey: string,
  corestoreDir: string,
): Promise<HyperdriveSetup> {
  const corestore = new Corestore(corestoreDir);
  await corestore.ready();

  const drive = new Hyperdrive(corestore, Buffer.from(hyperdriveKey, "hex"));
  await drive.ready();

  const getRelays = () => {
    const config = getSDKConfig();
    const relayPublicKeys = config.swarmRelays;
    if (!relayPublicKeys || relayPublicKeys.length === 0) {
      return null;
    }
    return relayPublicKeys.map((key: string) => Buffer.from(key, "hex"));
  };

  const swarmOptions: { relayThrough: () => Buffer[] | null } = {
    relayThrough: getRelays,
  };

  const swarm = new Hyperswarm(swarmOptions);
  const doneFindingPeers = drive.findingPeers();
  swarm.on("connection", (connection: Connection) => {
    logger.debug(`🤝 Connected to peer for hyperdrive download`);
    drive.replicate(connection);
  });
  swarm.join(drive.discoveryKey, { server: false, client: true });
  swarm.flush().then(doneFindingPeers, doneFindingPeers);

  registerCorestore(corestore, {
    label: `hyperdrive:${hyperdriveKey}`,
    createdAt: Date.now(),
  });
  registerSwarm(swarm, {
    label: `hyperdrive:${hyperdriveKey}`,
    createdAt: Date.now(),
  });

  return { corestore, drive, swarm, corestoreDir };
}

async function cleanupHyperdrive(setup: HyperdriveSetup): Promise<void> {
  logger.debug("🧹 Cleaning up hyperdrive setup");

  try {
    if (!setup.swarm.suspended) {
      try {
        await setup.swarm.suspend();
      } catch (error) {
        logger.debug("⚠️ Swarm suspend failed during cleanup:", error instanceof Error ? error.message : String(error));
      }
    }

    await setup.swarm.destroy();
    await setup.drive.close();
    await setup.corestore.close();
  } finally {
    unregisterSwarm(setup.swarm);
    unregisterCorestore(setup.corestore);
  }
}

export async function deleteCorestoreDirectory(
  corestoreDir: string,
): Promise<void> {
  logger.info(`🗑️ DELETING corestore directory... ${corestoreDir}`);
  try {
    await fsPromises.rm(corestoreDir, { recursive: true, force: true });
  } catch (e) {
    logger.error(
      `Error deleting corestore directory: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function findFileInHyperdrive(drive: Hyperdrive, modelFileName: string) {
  if (drive.core.length === 0) {
    // this method will update the length of the core using the first peer it finds
    // this will ensure that the hyperdrive is usable
    await drive.core.update();
  }

  const paths = [modelFileName, `/${modelFileName}`, `./${modelFileName}`];

  for (const pathVariation of paths) {
    try {
      const entry = await drive.entry(pathVariation, { wait: true });
      if (entry) {
        return { entry, targetPath: pathVariation };
      }
    } catch {
      // Continue trying other paths
    }
  }

  // If not found, list available files for debugging
  const availableFiles: string[] = [];
  try {
    // Try both with and without leading slash
    for (const prefix of ["/", ""]) {
      const files = drive.list(prefix, { recursive: true, wait: true });
      for await (const file of files) {
        availableFiles.push(file.key);
      }
      if (availableFiles.length > 0) break;
    }
  } catch {
    // Ignore listing errors
  }

  const filesInfo =
    availableFiles.length > 0
      ? `Available files: ${availableFiles.join(", ")}`
      : "Could not list available files";

  throw new FileNotFoundError(`${modelFileName} in hyperdrive. ${filesInfo}`);
}

async function checkFileDownloaded(drive: Hyperdrive, entry: Entry) {
  const blobs = await drive.getBlobs();
  const blob = entry?.value?.blob;
  if (!blob) {
    return {
      blobs,
      blocksDownloaded: 0,
      totalBlocks: 0,
      totalBytes: 0,
    };
  }

  // Check how many blocks are already downloaded
  let blocksDownloaded = 0;
  for (let i = blob.blockOffset; i < blob.blockOffset + blob.blockLength; i++) {
    const hasBlock = await blobs.core.has(i);
    if (hasBlock) {
      blocksDownloaded++;
    }
  }

  return {
    blobs,
    blocksDownloaded,
    totalBlocks: blob.blockLength,
    totalBytes: blob.byteLength,
  };
}

async function validateFileExistence(drive: Hyperdrive, file: string) {
  const { entry, targetPath } = await findFileInHyperdrive(drive, file);
  const { blobs, blocksDownloaded, totalBlocks, totalBytes } =
    await checkFileDownloaded(drive, entry);
  return {
    entry,
    blobs,
    targetPath,
    blocksDownloaded,
    totalBlocks,
    totalBytes,
  };
}

async function validateCachedFile(
  modelPath: string,
  modelFileName: string,
  expectedSize: number,
  expectedChecksum?: string,
  hooks?: DownloadHooks,
): Promise<string | null> {
  try {
    await fsPromises.access(modelPath);

    const localStats = await fsPromises.stat(modelPath);
    const localSize = localStats.size;

    // For hyperdrive: only validate if file is complete
    // Partial files are ignored - corestore state is the source of truth for resume
    if (localSize === expectedSize) {
      logger.info(`✅ Model cached with correct size: ${modelPath}`);

      // Always validate checksum if provided, even when size matches
      if (expectedChecksum && expectedChecksum.length === 64) {
        const checksum = await measureChecksum(modelPath, hooks);
        if (checksum !== expectedChecksum) {
          throw new ChecksumValidationFailedError(
            `${modelFileName}. Expected: ${expectedChecksum}. Actual: ${checksum}. File may be corrupted`,
          );
        }
      }
      logger.info(`✅ Model already cached and size validated: ${modelPath}`);
      return modelPath;
    }

    // File exists but incomplete - will be overwritten during download
    // Resume state will be determined by corestore blocks, not file size
    return null;
  } catch {
    // Model doesn't exist, need to download
    return null;
  }
}

async function downloadSingleFileToFilesystem(
  modelPath: string,
  modelFileName: string,
  hyperdriveKey: string,
  corestoreDir: string,
  downloadKey: string,
  expectedChecksum: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  seed?: boolean,
  signal?: AbortSignal,
  hooks?: DownloadHooks,
  shouldClearCache?: () => boolean,
): Promise<void> {
  // Check if already aborted
  if (signal?.aborted) {
    throw new DownloadCancelledError();
  }

  logger.info(
    `Downloading model from hyperdrive ${hyperdriveKey} to ${modelPath}`,
  );

  const setup = await setupHyperdrive(hyperdriveKey, corestoreDir);

  const cleanup = () => {
    logger.info("🛑 Aborting hyperdrive download...");
    setup.swarm.suspended = true;
    setup.swarm.suspend().catch(() => {
      // Ignore errors during emergency suspend
    });
  };

  signal?.addEventListener("abort", cleanup);

  let downloadSucceeded = false;
  try {
    const progressContext: ProgressContext | undefined = progressCallback
      ? {
          downloadKey,
          callback: progressCallback,
        }
      : undefined;

    await downloadAndValidateFile(
      setup.drive,
      modelFileName,
      modelPath,
      0, // Size will be determined from drive
      expectedChecksum,
      progressContext,
      signal,
      hooks,
    );

    logger.info(`✅ Model downloaded successfully to ${modelPath}`);

    // Send final 100% progress update
    if (progressCallback) {
      try {
        const stats = await fsPromises.stat(modelPath);
        progressCallback({
          type: "modelProgress",
          downloaded: stats.size,
          total: stats.size,
          percentage: 100,
          downloadKey,
        });
      } catch {
        // Ignore stat errors
      }
    }

    downloadSucceeded = true;
  } catch (error) {
    logger.error(
      "❌ Error during hyperdrive download:",
      error instanceof Error ? error.message : String(error),
    );
    if (error instanceof DownloadCancelledError) {
      throw error;
    }
    throw new HyperdriveDownloadFailedError(
      `Download failed for ${modelFileName} from hyperdrive: ${hyperdriveKey}`,
      error,
    );
  } finally {
    signal?.removeEventListener("abort", cleanup);

    if (!seed) {
      await cleanupHyperdrive(setup);
      // Delete only after close - Windows EBUSY on LOCK if deleted before corestore.close()
      if (downloadSucceeded) {
        await deleteCorestoreDirectory(corestoreDir);
      }
    }

    // Only delete corestore and partial file if user explicitly requested clearCache
    if (signal?.aborted && shouldClearCache?.()) {
      try {
        await fsPromises.unlink(modelPath);
      } catch (cleanupError) {
        logger.debug("Failed to delete partial model file during cleanup", {
          path: modelPath,
          error: cleanupError,
        });
      }
      await deleteCorestoreDirectory(corestoreDir);
    }
  }
}

async function downloadAndValidateFile(
  drive: Hyperdrive,
  sourceFileName: string,
  targetFilePath: string,
  expectedSize: number,
  expectedChecksum: string,
  progressContext?: ProgressContext,
  signal?: AbortSignal,
  hooks?: DownloadHooks,
): Promise<void> {
  const {
    entry,
    blobs,
    targetPath,
    blocksDownloaded,
    totalBlocks,
    totalBytes,
  } = await validateFileExistence(drive, sourceFileName);

  const blob = entry?.value?.blob;
  if (!blob) {
    throw new NoBlobFoundError(sourceFileName);
  }

  // Use actual file size from drive if expectedSize is 0
  const fileSizeToValidate = expectedSize || totalBytes;

  // Setup progress tracking
  let downloadedBytes = 0;
  const bytesPerBlock = totalBlocks > 0 ? totalBytes / totalBlocks : 0;
  const initialBytes = Math.floor(blocksDownloaded * bytesPerBlock);
  downloadedBytes = initialBytes;

  const progressHandler = (index: number, bytes: number) => {
    if (
      index >= blob.blockOffset &&
      index < blob.blockOffset + blob.blockLength
    ) {
      downloadedBytes += bytes;
      const cappedDownloaded = Math.min(downloadedBytes, totalBytes);

      if (progressContext) {
        const baseProgress = {
          type: "modelProgress" as const,
          downloaded: cappedDownloaded,
          total: totalBytes,
          percentage: calculatePercentage(cappedDownloaded, totalBytes),
          downloadKey: progressContext.downloadKey,
        };

        if (progressContext.shardInfo) {
          const currentOverall =
            progressContext.shardInfo.overallDownloaded + cappedDownloaded;
          progressContext.callback({
            ...baseProgress,
            shardInfo: {
              currentShard: progressContext.shardInfo.currentShard,
              totalShards: progressContext.shardInfo.totalShards,
              shardName: progressContext.shardInfo.shardName,
              overallDownloaded: currentOverall,
              overallTotal: progressContext.shardInfo.overallTotal,
              overallPercentage:
                progressContext.shardInfo.overallTotal > 0
                  ? (currentOverall / progressContext.shardInfo.overallTotal) *
                    100
                  : 0,
            },
          });
        } else {
          progressContext.callback(baseProgress);
        }
      }
    }
  };

  blobs.core.on("download", progressHandler);

  let readStream: Readable | undefined;
  let writeStream: Writable | undefined;

  try {
    // Download blocks and stream to file
    drive.download(targetPath);
    readStream = drive.createReadStream(targetPath) as unknown as Readable;
    writeStream = fs.createWriteStream(targetFilePath) as unknown as Writable;

    readStream.pipe(writeStream);

    await new Promise<void>((resolve, reject) => {
      writeStream!.on("finish", resolve);
      writeStream!.on("error", reject);
      readStream!.on("error", reject);

      signal?.addEventListener(
        "abort",
        () => reject(new DownloadCancelledError()),
        { once: true },
      );
    });

    blobs.core.off("download", progressHandler);

    // Validate file size
    const stats = await fsPromises.stat(targetFilePath);
    if (stats.size !== fileSizeToValidate) {
      throw new ChecksumValidationFailedError(
        `${path.basename(targetFilePath)}. File size mismatch: expected ${fileSizeToValidate}, got ${stats.size}`,
      );
    }

    // Validate checksum
    if (expectedChecksum && expectedChecksum.length === 64) {
      const checksum = await measureChecksum(targetFilePath, hooks);
      if (checksum !== expectedChecksum) {
        await fsPromises.unlink(targetFilePath);
        throw new ChecksumValidationFailedError(
          `${path.basename(targetFilePath)}. Expected: ${expectedChecksum}. Actual: ${checksum}`,
        );
      }
    } else if (!expectedChecksum) {
      logger.warn(`⚠️  No checksum available for validation`);
    }
  } catch (error) {
    if (readStream) {
      readStream.destroy();
    }
    if (writeStream) {
      writeStream.destroy();
    }
    blobs.core.off("download", progressHandler);
    throw error;
  }
}

async function downloadShardedFilesToFilesystem(
  hyperdriveKey: string,
  firstShardFileName: string,
  shardMetadata: readonly ShardFileMetadata[],
  progressCallback?: (progress: ModelProgressUpdate) => void,
  seed?: boolean,
  signal?: AbortSignal,
  hooks?: DownloadHooks,
  shouldClearCache?: () => boolean,
): Promise<string> {
  if (signal?.aborted) {
    throw new DownloadCancelledError();
  }

  const shardInfo = detectShardedModel(firstShardFileName);
  if (!shardInfo.isSharded || !shardInfo.totalShards) {
    throw new ModelLoadFailedError(
      `Not a sharded model: ${firstShardFileName}`,
    );
  }

  const shardDir = getShardedModelCacheDir(hyperdriveKey);
  const allFiles = shardMetadata.map((s) => s.filename);
  const numberedShardCount = shardInfo.totalShards;

  logger.info(
    `Downloading sharded model with ${numberedShardCount} numbered shards + ${allFiles.length - numberedShardCount} companion files to ${shardDir}`,
  );

  // Check which files need to be downloaded
  const invalidIndices = await checkShardCompleteness(
    hyperdriveKey,
    allFiles,
    shardMetadata,
    hooks?.addChecksumValidationTimeMs ? (ms) => hooks.addChecksumValidationTimeMs!(ms) : undefined,
  );

  if (invalidIndices.length === 0) {
    logger.info(
      `✅ All ${allFiles.length} files already downloaded and validated`,
    );
    hooks?.markCacheHit?.();

    if (progressCallback) {
      const overallTotal = shardMetadata.reduce(
        (sum, shard) => sum + shard.expectedSize,
        0,
      );
      const lastFile = allFiles[allFiles.length - 1]!;
      progressCallback({
        type: "modelProgress",
        downloaded: overallTotal,
        total: overallTotal,
        percentage: 100,
        downloadKey: createHyperdriveDownloadKey(
          hyperdriveKey,
          firstShardFileName,
        ),
        shardInfo: {
          currentShard: allFiles.length,
          totalShards: allFiles.length,
          shardName: lastFile,
          overallDownloaded: overallTotal,
          overallTotal,
          overallPercentage: 100,
        },
      });
    }

    await extractTensorsFromShards(shardDir, firstShardFileName);

    return getShardPath(hyperdriveKey, allFiles[0]!);
  }

  logger.info(
    `📥 Need to download ${invalidIndices.length} of ${allFiles.length} files`,
  );
  hooks?.markCacheMiss?.();

  // Setup hyperdrive once for all shards
  const corestoreDir = getCorestoreDir(hyperdriveKey);
  const setup = await setupHyperdrive(hyperdriveKey, corestoreDir);

  const cleanup = () => {
    logger.info("🛑 Aborting sharded hyperdrive download...");
    setup.swarm.suspended = true;
    setup.swarm.suspend().catch(() => {
      // Ignore errors during emergency suspend
    });
  };

  signal?.addEventListener("abort", cleanup);

  let downloadSucceeded = false;
  try {
    // Calculate overall progress
    const overallTotal = shardMetadata.reduce(
      (sum, shard) => sum + shard.expectedSize,
      0,
    );
    let overallDownloaded = 0;

    // Download each file sequentially
    for (let i = 0; i < allFiles.length; i++) {
      if (signal?.aborted) {
        throw new DownloadCancelledError();
      }

      const file = allFiles[i]!;
      const fileMeta = shardMetadata[i]!;
      const filePath = getShardPath(hyperdriveKey, file);

      // Skip if already valid
      if (!invalidIndices.includes(i)) {
        logger.debug(
          `✅ File ${i + 1}/${allFiles.length} already valid: ${file}`,
        );
        overallDownloaded += fileMeta.expectedSize;

        // Report progress for skipped files
        if (progressCallback) {
          progressCallback({
            type: "modelProgress",
            downloaded: fileMeta.expectedSize,
            total: fileMeta.expectedSize,
            percentage: 100,
            downloadKey: createHyperdriveDownloadKey(
              hyperdriveKey,
              firstShardFileName,
            ),
            shardInfo: {
              currentShard: i + 1,
              totalShards: allFiles.length,
              shardName: file,
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

      logger.info(`📥 Downloading file ${i + 1}/${allFiles.length}: ${file}`);

      const progressContext: ProgressContext | undefined = progressCallback
        ? {
            downloadKey: createHyperdriveDownloadKey(
              hyperdriveKey,
              firstShardFileName,
            ),
            callback: progressCallback,
            shardInfo: {
              currentShard: i + 1,
              totalShards: allFiles.length,
              shardName: file,
              overallDownloaded,
              overallTotal,
            },
          }
        : undefined;

      await downloadAndValidateFile(
        setup.drive,
        file,
        filePath,
        fileMeta.expectedSize,
        fileMeta.sha256Checksum,
        progressContext,
        signal,
        hooks,
      );

      if (signal?.aborted) {
        throw new DownloadCancelledError();
      }

      logger.info(
        `✅ File ${i + 1}/${allFiles.length} downloaded and validated`,
      );
      overallDownloaded += fileMeta.expectedSize;
    }

    if (progressCallback && overallDownloaded === overallTotal) {
      const lastFile = allFiles[allFiles.length - 1]!;
      progressCallback({
        type: "modelProgress",
        downloaded: overallTotal,
        total: overallTotal,
        percentage: 100,
        downloadKey: createHyperdriveDownloadKey(
          hyperdriveKey,
          firstShardFileName,
        ),
        shardInfo: {
          currentShard: allFiles.length,
          totalShards: allFiles.length,
          shardName: lastFile,
          overallDownloaded,
          overallTotal,
          overallPercentage: 100,
        },
      });
    }

    await extractTensorsFromShards(shardDir, firstShardFileName);

    downloadSucceeded = true;
  } catch (error) {
    logger.error(
      "❌ Error during sharded hyperdrive download:",
      error instanceof Error ? error.message : String(error),
    );
    // Preserve cancellation errors
    if (error instanceof DownloadCancelledError) {
      throw error;
    }
    throw new HyperdriveDownloadFailedError(
      `Sharded download failed for ${firstShardFileName} from hyperdrive: ${hyperdriveKey}`,
      error,
    );
  } finally {
    signal?.removeEventListener("abort", cleanup);

    if (!seed) {
      await cleanupHyperdrive(setup);
      // Delete only after close - Windows EBUSY on LOCK if deleted before corestore.close()
      if (downloadSucceeded) {
        await deleteCorestoreDirectory(corestoreDir);
      }
    }

    // Only delete corestore and partial files if user explicitly requested clearCache
    if (signal?.aborted && shouldClearCache?.()) {
      await deleteCorestoreDirectory(corestoreDir);
    }
  }

  return getShardPath(hyperdriveKey, allFiles[0]!);
}

export async function downloadModelFromHyperdrive(
  hyperdriveKey: string,
  modelFileName: string,
  seed?: boolean,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  hooks?: DownloadHooks,
  expectedChecksum?: string,
): Promise<string> {
  const downloadKey = createHyperdriveDownloadKey(hyperdriveKey, modelFileName);
  hooks?.onDownloadKey?.(downloadKey);
  const shardInfo = detectShardedModel(modelFileName);
  const model = getModelBySrc(modelFileName, hyperdriveKey);

  const result = startOrJoinDownload(
    downloadKey,
    async (ctx) => {
      if (shardInfo.isSharded && model?.shardMetadata) {
        const hooksWithCacheHit: DownloadHooks = {
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

        return downloadShardedFilesToFilesystem(
          hyperdriveKey,
          modelFileName,
          model.shardMetadata,
          ctx.broadcastProgress,
          seed,
          ctx.signal,
          hooksWithCacheHit,
          ctx.shouldClearCache,
        );
      }

      // Non-sharded model download
      const corestoreDir = getCorestoreDir(hyperdriveKey);
      const cacheDir = getModelsCacheDir();
      const sourceHash = generateShortHash(
        `${hyperdriveKey}/${modelFileName}`,
      );
      const modelPath = path.join(
        cacheDir,
        `${sourceHash}_${modelFileName}`,
      );

      // First, check if we already have a valid cached file (only if we have model metadata)
      if (model) {
        const cachedPath = await validateCachedFile(
          modelPath,
          modelFileName,
          model.expectedSize,
          expectedChecksum || model.sha256Checksum,
          hooks,
        );

        if (cachedPath) {
          hooks?.markCacheHit?.();
          ctx.setCacheHit(true);
          ctx.broadcastProgress({
            type: "modelProgress",
            downloaded: model.expectedSize,
            total: model.expectedSize,
            percentage: 100,
            downloadKey,
          });

          // Delete any leftover corestore directory from previous runs (only when not seeding)
          if (!seed) {
            await deleteCorestoreDirectory(corestoreDir);
          }
          return cachedPath;
        }
      }

      hooks?.markCacheMiss?.();
      ctx.setCacheHit(false);
      const checksumToValidate =
        expectedChecksum || model?.sha256Checksum || "";

      await downloadSingleFileToFilesystem(
        modelPath,
        modelFileName,
        hyperdriveKey,
        corestoreDir,
        downloadKey,
        checksumToValidate,
        ctx.broadcastProgress,
        seed,
        ctx.signal,
        hooks,
        ctx.shouldClearCache,
      );

      return modelPath;
    },
    progressCallback,
  );

  return applyJoinedDownloadStats(result, hooks);
}
