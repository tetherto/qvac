import type {
  ModelProgressUpdate,
  HttpDownloadEntry,
  ShardUrl,
} from "@/schemas";
import fs, { promises as fsPromises } from "bare-fs";
import path from "bare-path";
import { Readable, type Writable } from "bare-stream";
import fetch from "bare-fetch";
import { AbortController, type AbortSignal } from "bare-abort-controller";
import { withTimeout } from "@/utils/withTimeout";
import {
  getModelsCacheDir,
  getShardedModelCacheDir,
  generateShortHash,
  detectShardedModel,
  parsePatternBasedShardUrl,
  extractTensorsFromShards,
  calculatePercentage,
  isArchiveUrl,
  extractAndValidateShardedArchive,
  validateShardedModelCache,
  checkAllShardsExist,
  generateShardFilenames,
  hasValidGGUFHeader,
} from "@/server/utils";
import { getSDKConfig } from "@/server/bare/registry/config-registry";
import {
  getActiveDownload,
  registerDownload,
  unregisterDownload,
  createHttpDownloadKey,
  shouldClearCache,
  clearClearCacheFlag,
} from "@/server/rpc/handlers/load-model/download-manager";
import {
  DownloadCancelledError,
  HTTPError,
  NoResponseBodyError,
  PartialDownloadOfflineError,
  ResponseBodyNotReadableError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

const DEFAULT_CONCURRENCY = 3;

interface ShardDownloadState {
  index: number;
  shard: ShardUrl;
  shardPath: string;
  expectedSize: number;
  downloadedBytes: number;
  isComplete: boolean;
}

const DEFAULT_HTTP_CONNECTION_TIMEOUT_MS = 10_000;

function extractFilenameFromUrl(url: string): string {
  // Parse URL to get the filename from the path
  const urlParts = url.split("/");
  const filename = urlParts[urlParts.length - 1] || "model.gguf";

  // Remove query parameters if present
  const cleanFilename = filename.split("?")[0] || "model.gguf";

  return cleanFilename;
}

async function validateCachedFile(
  modelPath: string,
  url: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    await fsPromises.access(modelPath);

    const localStats = await fsPromises.stat(modelPath);
    const localSize = localStats.size;

    const config = getSDKConfig();
    const connectionTimeout =
      config.httpConnectionTimeoutMs ?? DEFAULT_HTTP_CONNECTION_TIMEOUT_MS;
    let expectedSize = 0;
    try {
      const response = await withTimeout(
        fetch(url, {
          method: "HEAD",
          ...(signal && { signal }),
        }),
        connectionTimeout,
      );
      expectedSize = parseInt(response.headers.get("content-length") || "0");
    } catch (headError) {
      logger.warn(
        `⚠️ HEAD request failed: ${headError instanceof Error ? headError.message : String(headError)}`,
      );
      logger.info(`📴 Falling back to GGUF header validation...`);

      const hasValidHeader = await hasValidGGUFHeader(modelPath);
      if (hasValidHeader) {
        logger.info(
          `✅ Offline - GGUF header valid, using cached file: ${modelPath}`,
        );
        return modelPath;
      }

      if (localSize > 0) {
        logger.error(
          `❌ Offline with partial download (${localSize} bytes). Cannot resume without network.`,
        );
        throw new PartialDownloadOfflineError(url, localSize);
      }

      logger.warn(
        `⚠️ Offline and GGUF validation failed - file may be incomplete`,
      );
      return null;
    }

    if (localSize !== expectedSize) {
      logger.info(
        `📥 Cached file size mismatch. Expected: ${expectedSize}, Found: ${localSize}. Re-downloading...`,
      );
      return null;
    }

    logger.info(`✅ Using cached HTTP model: ${modelPath}`);
    return modelPath;
  } catch (error) {
    // Re-throw PartialDownloadOfflineError
    if (error instanceof PartialDownloadOfflineError) {
      throw error;
    }
    // File doesn't exist or other access error
    return null;
  }
}

async function performHttpDownload(
  url: string,
  modelPath: string,
  downloadKey: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new DownloadCancelledError();
  }

  logger.info(`📥 Downloading model from HTTP: ${url}`);

  // Check if file exists for resuming
  let startOffset = 0;
  let downloadedBytes = 0;

  try {
    const existingStats = await fsPromises.stat(modelPath);
    startOffset = existingStats.size;
    downloadedBytes = startOffset;
    logger.info(`📥 Resuming download from byte ${startOffset}`);
  } catch {
    logger.info(`📥 Starting fresh download`);
  }

  // Prepare headers for resume if needed
  const headers: Record<string, string> = {
    "User-Agent": "qvac-sdk",
  };

  if (startOffset > 0) {
    headers["Range"] = `bytes=${startOffset}-`;
  }

  const config = getSDKConfig();
  const connectionTimeout =
    config.httpConnectionTimeoutMs ?? DEFAULT_HTTP_CONNECTION_TIMEOUT_MS;

  let response;
  try {
    response = await withTimeout(
      fetch(url, {
        method: "GET",
        headers,
        ...(signal && { signal }),
      }),
      connectionTimeout,
    );
  } catch (error) {
    // Check if it was parent abort
    if (signal?.aborted) {
      throw new DownloadCancelledError();
    }
    // Connection timeout or network error
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(`❌ Connection failed: ${errorMsg}. URL: ${url}`);
    throw new HTTPError(0, `Connection failed: ${errorMsg}`, error);
  }

  if (!response.ok) {
    // Check if it's a 416 (Range Not Satisfiable) - file already complete
    if (response.status === 416 && startOffset > 0) {
      logger.info(`✅ File already completely downloaded`);
      // Send 100% progress for already complete file
      if (progressCallback) {
        progressCallback({
          type: "modelProgress",
          downloaded: startOffset,
          total: startOffset,
          percentage: 100,
          downloadKey,
        });
      }
      return;
    }

    // Check if server doesn't support range requests
    if (response.status === 200 && startOffset > 0) {
      logger.warn(`⚠️ Server doesn't support resume, starting fresh download`);
      startOffset = 0;
      downloadedBytes = 0;

      // Retry without Range header
      response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "qvac-sdk",
        },
        ...(signal && { signal }),
      });

      if (!response.ok) {
        throw new HTTPError(response.status, response.statusText);
      }
    } else if (response.status !== 206) {
      // 206 is Partial Content (successful resume)
      throw new HTTPError(response.status, response.statusText);
    }
  }

  // Get total size from headers
  let totalBytes = 0;
  const contentLength = response.headers.get("content-length");

  if (response.status === 206) {
    // For resumed downloads, parse Content-Range header
    const contentRange = response.headers.get("content-range");
    if (contentRange) {
      const match = contentRange.match(/bytes \d+-\d+\/(\d+)/);
      if (match && match[1]) {
        totalBytes = parseInt(match[1]);
      }
    }
  } else {
    // For fresh downloads
    totalBytes = contentLength ? parseInt(contentLength) : 0;
  }

  logger.info(
    `📏 Total size: ${totalBytes} bytes (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`,
  );

  // Create write stream (append if resuming)
  const writeStreamOptions =
    startOffset > 0 && response.status === 206 ? { flags: "a" } : {};
  const writeStream = fs.createWriteStream(modelPath, writeStreamOptions);

  // Get the response body
  const body = response.body;

  if (!body) {
    throw new NoResponseBodyError();
  }

  try {
    // Check if body has pipe method (it's a Node/Bare stream)
    const isReadable =
      body instanceof Readable ||
      (typeof (body as unknown as Readable).pipe === "function" &&
        typeof (body as unknown as Readable).on === "function");

    if (isReadable) {
      // Track progress by intercepting data events if possible
      (body as Readable).on("data", (chunk) => {
        downloadedBytes += (chunk as Buffer).length;
        if (progressCallback) {
          progressCallback({
            type: "modelProgress",
            downloaded: downloadedBytes,
            total: totalBytes,
            percentage: calculatePercentage(downloadedBytes, totalBytes),
            downloadKey,
          });
        }
      });

      // Pipe directly to file
      (body as Readable).pipe(writeStream as unknown as Writable);

      // Wait for download to complete
      await new Promise((resolve, reject) => {
        // Handle abort signal
        const abortHandler = () => {
          const error = new Error("Download cancelled");
          (body as Readable).destroy();
          writeStream.destroy();
          reject(error);
        };

        if (signal) {
          signal.addEventListener("abort", abortHandler);
        }

        writeStream.on("finish", () => {
          logger.info(`✅ Model downloaded successfully to ${modelPath}`);
          if (signal) {
            signal.removeEventListener("abort", abortHandler);
          }
          resolve(undefined);
        });
        writeStream.on("error", reject);
        (body as Readable).on("error", reject);
      });
    } else if (body[Symbol.asyncIterator]) {
      // Body is an async iterable (for await...of)
      for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
        // Check if abort signal is triggered
        if (signal && signal.aborted) {
          writeStream.destroy();
          throw new DownloadCancelledError();
        }

        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        downloadedBytes += buffer.length;

        if (progressCallback) {
          progressCallback({
            type: "modelProgress",
            downloaded: downloadedBytes,
            total: totalBytes,
            percentage: calculatePercentage(downloadedBytes, totalBytes),
            downloadKey,
          });
        }

        // Write chunk to file
        await new Promise<void>((resolve, reject) => {
          writeStream.write(buffer, (err) => {
            if (err)
              reject(
                new Error(err instanceof Error ? err.message : String(err)),
              );
            else resolve();
          });
        });
      }

      // Close the write stream
      await new Promise<void>((resolve, reject) => {
        writeStream.end(() => {
          logger.info(`✅ Model downloaded successfully to ${modelPath}`);
          resolve();
        });
        writeStream.on("error", reject);
      });
    } else {
      // Fallback: try to use getReader() if it's a ReadableStream
      const readableStreamBody = body as unknown as {
        getReader?: () => {
          read: () => Promise<{ done: boolean; value: Uint8Array }>;
          releaseLock: () => void;
        };
      };
      const reader = readableStreamBody.getReader
        ? readableStreamBody.getReader()
        : null;
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const buffer = Buffer.from(value);
            downloadedBytes += buffer.length;

            if (progressCallback) {
              progressCallback({
                type: "modelProgress",
                downloaded: downloadedBytes,
                total: totalBytes,
                percentage: calculatePercentage(downloadedBytes, totalBytes),
                downloadKey,
              });
            }

            // Write chunk to file
            await new Promise<void>((resolve, reject) => {
              writeStream.write(buffer, (err) => {
                if (err)
                  reject(
                    new Error(err instanceof Error ? err.message : String(err)),
                  );
                else resolve();
              });
            });
          }
        } finally {
          reader.releaseLock();
        }

        // Close the write stream
        await new Promise<void>((resolve, reject) => {
          writeStream.end(() => {
            logger.info(`✅ Model downloaded successfully to ${modelPath}`);
            resolve();
          });
          writeStream.on("error", reject);
        });
      } else {
        throw new ResponseBodyNotReadableError();
      }
    }
  } catch (error) {
    writeStream.destroy();
    logger.error(
      "Error during download:",
      error instanceof Error ? error.message : String(error),
    );
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function downloadModelFromHttp(
  url: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
) {
  const filename = extractFilenameFromUrl(url);

  if (isArchiveUrl(url)) {
    return downloadShardedModelFromArchive(url, progressCallback);
  }

  const shardInfo = detectShardedModel(filename);

  if (shardInfo.isSharded && shardInfo.totalShards) {
    return downloadShardedModelFromHttp(url, progressCallback);
  }

  const downloadKey = createHttpDownloadKey(url);

  const existing = getActiveDownload(downloadKey);
  if (existing) {
    logger.info(`📥 Reusing existing download for: ${downloadKey}`);
    return existing.promise;
  }

  const cacheDir = getModelsCacheDir();
  const sourceHash = generateShortHash(url);
  const modelPath = `${cacheDir}/${sourceHash}_${filename}`;

  // Create managed download with AbortController
  const abortController = new AbortController();

  const downloadPromise = (async () => {
    try {
      // Check if already cached
      const cachedPath = await validateCachedFile(
        modelPath,
        url,
        abortController.signal,
      );
      if (cachedPath) {
        if (progressCallback) {
          try {
            const stats = await fsPromises.stat(cachedPath);
            progressCallback({
              type: "modelProgress",
              downloaded: stats.size,
              total: stats.size,
              percentage: 100,
              downloadKey,
            });
          } catch (error) {
            logger.debug("Failed to get file stats for progress callback", {
              path: cachedPath,
              error,
            });
          }
        }
        return cachedPath;
      }

      // Download the file
      await performHttpDownload(
        url,
        modelPath,
        downloadKey,
        progressCallback,
        abortController.signal,
      );

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
        } catch (error) {
          logger.debug("Failed to get file stats for final progress update", {
            path: modelPath,
            error,
          });
        }
      }

      return modelPath;
    } catch (error) {
      logger.error(
        "❌ Error downloading model:",
        error instanceof Error ? error.message : String(error),
      );

      // Check if we should delete the partial file (clearCache was requested)
      if (error instanceof Error && error.message === "Download cancelled") {
        if (shouldClearCache(downloadKey)) {
          logger.info("🗑️ Clearing cache - deleting partial file");
          try {
            await fsPromises.unlink(modelPath);
            logger.info(`✅ Deleted partial file: ${modelPath}`);
          } catch (error) {
            logger.debug("Failed to delete partial file during cleanup", {
              path: modelPath,
              error,
            });
          }
        } else {
          logger.info("📥 Download paused - partial file preserved for resume");
        }
        clearClearCacheFlag(downloadKey);
      }

      const errorToThrow =
        error instanceof Error ? error : new Error(String(error));
      throw errorToThrow;
    } finally {
      // Cleanup from download manager
      unregisterDownload(downloadKey);
    }
  })();

  // Register download
  const downloadEntry: HttpDownloadEntry = {
    key: downloadKey,
    promise: downloadPromise,
    abortController,
    startTime: Date.now(),
    type: "http",
    url,
    modelPath,
    ...(progressCallback && { onProgress: progressCallback }),
  };

  registerDownload(downloadKey, downloadEntry);

  return downloadPromise;
}

async function downloadShardedModelFromHttp(
  shardUrl: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
) {
  const config = getSDKConfig();
  const concurrency = config.httpDownloadConcurrency ?? DEFAULT_CONCURRENCY;
  const { shardUrls: shardInfos, cacheKey } =
    parsePatternBasedShardUrl(shardUrl);
  const downloadKey = `http-sharded:${cacheKey}`;

  logger.info(
    `📥 HTTP sharded download: ${shardInfos.length} shards detected from ${shardUrl}`,
  );

  const existing = getActiveDownload(downloadKey);
  if (existing) {
    logger.info(`📥 Reusing existing sharded download for: ${downloadKey}`);
    return existing.promise;
  }

  const abortController = new AbortController();
  const shardDir = getShardedModelCacheDir(cacheKey);

  const downloadPromise = (async () => {
    try {
      const shardStates: ShardDownloadState[] = await Promise.all(
        shardInfos.map(async (shard, index) => {
          const shardPath = path.join(shardDir, shard.filename);
          let expectedSize = 0;

          try {
            const response = await fetch(shard.url, {
              method: "HEAD",
              signal: abortController.signal,
            });
            expectedSize = parseInt(
              response.headers.get("content-length") || "0",
            );
          } catch (error) {
            logger.warn("Failed to get shard size via HEAD request", {
              url: shard.url,
              error,
            });
            // expectedSize remains 0, progress percentage will be 0
          }

          return {
            index,
            shard,
            shardPath,
            expectedSize,
            downloadedBytes: 0,
            isComplete: false,
          };
        }),
      );

      const overallTotal = shardStates.reduce(
        (sum, s) => sum + s.expectedSize,
        0,
      );

      logger.info(
        `📏 Total size: ${overallTotal} bytes (${(overallTotal / 1024 / 1024).toFixed(2)} MB)`,
      );

      const cacheChecks = await Promise.all(
        shardStates.map(async (state) => {
          const cached = await validateCachedFile(
            state.shardPath,
            state.shard.url,
            abortController.signal,
          );
          return { state, isCached: cached !== null };
        }),
      );

      const shardsToDownload = cacheChecks
        .filter((c) => !c.isCached)
        .map((c) => c.state);

      for (const check of cacheChecks) {
        if (check.isCached) {
          check.state.isComplete = true;
          check.state.downloadedBytes = check.state.expectedSize;
        }
      }

      logger.info(
        `📥 ${shardsToDownload.length} of ${shardInfos.length} shards need downloading`,
      );

      await downloadShardsWithConcurrency(
        shardsToDownload,
        shardStates,
        concurrency,
        abortController.signal,
        downloadKey,
        overallTotal,
        progressCallback,
      );

      logger.info(`✅ All ${shardInfos.length} shards downloaded successfully`);

      await extractTensorsFromShards(shardDir, shardInfos[0]!.filename);

      return path.join(shardDir, shardInfos[0]!.filename);
    } catch (error) {
      logger.error(
        "❌ Error during sharded download:",
        error instanceof Error ? error.message : String(error),
      );

      if (error instanceof Error && error.message === "Download cancelled") {
        if (shouldClearCache(downloadKey)) {
          logger.info("🗑️ Clearing cache - deleting partial shard files");
          try {
            await fsPromises.rm(shardDir, { recursive: true, force: true });
            logger.info(`✅ Deleted shard directory: ${shardDir}`);
          } catch (cleanupError) {
            logger.debug("Failed to delete shard directory during cleanup", {
              path: shardDir,
              error: cleanupError,
            });
          }
        }
      }

      throw error;
    } finally {
      unregisterDownload(downloadKey);
      clearClearCacheFlag(downloadKey);
    }
  })();

  registerDownload(downloadKey, {
    key: downloadKey,
    promise: downloadPromise,
    abortController,
    startTime: Date.now(),
    type: "http",
    url: shardUrl,
    modelPath: shardDir,
  } as HttpDownloadEntry);

  return downloadPromise;
}

async function downloadShardedModelFromArchive(
  archiveUrl: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
) {
  const filename = extractFilenameFromUrl(archiveUrl);
  const sourceHash = generateShortHash(archiveUrl);
  const downloadKey = `http-archive:${sourceHash}`;

  logger.info(`📦 HTTP archive download: ${filename}`);

  const existing = getActiveDownload(downloadKey);
  if (existing) {
    logger.info(`📥 Reusing existing archive download for: ${downloadKey}`);
    return existing.promise;
  }

  const abortController = new AbortController();
  const extractDir = getShardedModelCacheDir(sourceHash);
  const archivePath = path.join(extractDir, `${sourceHash}_${filename}`);

  const downloadPromise = (async () => {
    try {
      await fsPromises.mkdir(extractDir, { recursive: true });

      const files = await fsPromises.readdir(extractDir);
      const shardedFile = files.find(
        (f) => detectShardedModel(String(f)).isSharded,
      );

      if (!shardedFile) {
        return downloadAndExtractArchive();
      }

      const shardFilename = String(shardedFile);
      const allShardsExist = await checkAllShardsExist(
        extractDir,
        shardFilename,
      );

      if (!allShardsExist) {
        logger.warn(`⚠️ Incomplete shards found, re-downloading archive`);
        return downloadAndExtractArchive();
      }

      const shardFilenames = generateShardFilenames(shardFilename);
      const firstShard = path.join(extractDir, shardFilenames[0]!);
      const isComplete = await validateShardedModelCache(
        extractDir,
        shardFilename,
      );

      if (isComplete) {
        logger.info(`✅ Archive already extracted: ${extractDir}`);
        if (progressCallback) {
          progressCallback({
            type: "modelProgress",
            downloaded: 1,
            total: 1,
            percentage: 100,
            downloadKey,
          });
        }
        return firstShard;
      }

      logger.info(
        `📝 All shards present but tensors.txt missing, extracting tensors...`,
      );
      try {
        await extractTensorsFromShards(extractDir, shardFilename);
        logger.info(`✅ Tensors extracted successfully`);
        if (progressCallback) {
          progressCallback({
            type: "modelProgress",
            downloaded: 1,
            total: 1,
            percentage: 100,
            downloadKey,
          });
        }
        return firstShard;
      } catch (error) {
        logger.warn(`Failed to extract tensors, will re-download archive`, {
          error,
        });
        return downloadAndExtractArchive();
      }
    } catch (error) {
      logger.error("❌ Error downloading/extracting archive:", error);
      throw error;
    } finally {
      unregisterDownload(downloadKey);
    }

    async function downloadAndExtractArchive() {
      await performHttpDownload(
        archiveUrl,
        archivePath,
        downloadKey,
        progressCallback,
        abortController.signal,
      );

      logger.info(`✅ Archive downloaded, extracting to: ${extractDir}`);

      const firstShardPath = await extractAndValidateShardedArchive(
        archivePath,
        extractDir,
        abortController.signal,
      );

      try {
        await fsPromises.unlink(archivePath);
        logger.info(`🗑️ Cleaned up archive file: ${archivePath}`);
      } catch (cleanupError) {
        logger.debug("Failed to delete archive file during cleanup", {
          path: archivePath,
          error: cleanupError,
        });
      }

      return firstShardPath;
    }
  })();

  registerDownload(downloadKey, {
    key: downloadKey,
    promise: downloadPromise,
    abortController,
    startTime: Date.now(),
    type: "http",
    url: archiveUrl,
    modelPath: archivePath,
  } as HttpDownloadEntry);

  return downloadPromise;
}

async function downloadShardsWithConcurrency(
  shardsToDownload: ShardDownloadState[],
  allShards: ShardDownloadState[],
  concurrency: number,
  signal: AbortSignal,
  downloadKey: string,
  overallTotal: number,
  progressCallback?: (progress: ModelProgressUpdate) => void,
) {
  const queue = [...shardsToDownload];
  const inFlight = new Set<Promise<void>>();

  while (queue.length > 0 || inFlight.size > 0) {
    if (signal.aborted) {
      throw new DownloadCancelledError();
    }

    while (queue.length > 0 && inFlight.size < concurrency) {
      const state = queue.shift()!;

      const downloadPromise = (async () => {
        logger.info(
          `📥 Downloading shard ${state.index + 1}: ${state.shard.filename}`,
        );

        await performHttpDownload(
          state.shard.url,
          state.shardPath,
          downloadKey,
          (progress) => {
            state.downloadedBytes = progress.downloaded;

            if (progressCallback) {
              const overallDownloaded = allShards.reduce(
                (sum, s) => sum + s.downloadedBytes,
                0,
              );

              progressCallback({
                type: "modelProgress",
                downloaded: state.downloadedBytes,
                total: state.expectedSize,
                percentage: calculatePercentage(
                  state.downloadedBytes,
                  state.expectedSize,
                ),
                downloadKey,
                shardInfo: {
                  currentShard: state.index + 1,
                  totalShards: allShards.length,
                  shardName: state.shard.filename,
                  overallDownloaded,
                  overallTotal,
                  overallPercentage: calculatePercentage(
                    overallDownloaded,
                    overallTotal,
                  ),
                },
              });
            }
          },
          signal,
        );

        logger.info(
          `✅ Shard ${state.index + 1} complete: ${state.shard.filename}`,
        );
      })().finally(() => {
        inFlight.delete(downloadPromise);
      });

      inFlight.add(downloadPromise);
    }

    if (inFlight.size > 0) {
      await Promise.race(inFlight);
    }
  }

  // Mark all downloaded shards as complete
  for (const state of shardsToDownload) {
    state.isComplete = true;
    state.downloadedBytes = state.expectedSize;
  }

  if (progressCallback) {
    progressCallback({
      type: "modelProgress",
      downloaded: overallTotal,
      total: overallTotal,
      percentage: 100,
      downloadKey,
      shardInfo: {
        currentShard: allShards.length,
        totalShards: allShards.length,
        shardName: allShards[allShards.length - 1]!.shard.filename,
        overallDownloaded: overallTotal,
        overallTotal,
        overallPercentage: 100,
      },
    });
  }
}
