import type { ModelProgressUpdate, ShardUrl } from "@/schemas";
import fs, { promises as fsPromises } from "bare-fs";
import path from "bare-path";
import { Readable, type Writable } from "bare-stream";
import fetch, { Headers } from "bare-fetch";
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
  sanitizePathComponent,
  extractAndValidateShardedArchive,
  validateShardedModelCache,
  checkAllShardsExist,
  generateShardFilenames,
  hasValidGGUFHeader,
} from "@/server/utils";
import { getSDKConfig } from "@/server/bare/registry/config-registry";
import { getLifecycleState, onResume } from "@/server/bare/runtime-lifecycle";
import {
  createHttpDownloadKey,
  startOrJoinDownload,
  applyJoinedDownloadStats,
} from "@/server/rpc/handlers/load-model/download-manager";
import {
  DownloadCancelledError,
  HTTPError,
  NoResponseBodyError,
  PartialDownloadOfflineError,
  ResponseBodyNotReadableError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";
import type { DownloadHooks } from "./types";

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
// If no bytes arrive for this long mid-stream, treat the transfer as stalled
// (dead socket after a suspend or network drop that didn't surface an error)
// and abort so the caller can resume from the partial via a Range request.
const HTTP_STREAM_STALL_TIMEOUT_MS = 10_000;

function extractFilenameFromUrl(url: string): string {
  // Parse URL to get the filename from the path
  const urlParts = url.split("/");
  const filename = urlParts[urlParts.length - 1] || "model.gguf";

  // Remove query parameters if present
  const cleanFilename = filename.split("?")[0] || "model.gguf";

  // Sanitize to prevent path traversal via crafted URLs
  return sanitizePathComponent(cleanFilename);
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
  const headers = new Headers({
    "User-Agent": "qvac-sdk",
  });

  if (startOffset > 0) {
    headers.append("Range", `bytes=${startOffset}-`);
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
        headers: new Headers({
          "User-Agent": "qvac-sdk",
        }),
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
      // Wait for download to complete
      await new Promise((resolve, reject) => {
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        const clearStall = () => {
          if (stallTimer) {
            clearTimeout(stallTimer);
            stallTimer = undefined;
          }
        };
        // Reset on every chunk; if it ever fires, the socket went quiet
        // mid-stream (suspend/drop) — abort so the caller resumes via Range.
        const armStall = () => {
          clearStall();
          stallTimer = setTimeout(() => {
            (body as Readable).destroy();
            writeStream.destroy();
            reject(
              new Error(
                `HTTP stream stalled: no data for ${HTTP_STREAM_STALL_TIMEOUT_MS}ms`,
              ),
            );
          }, HTTP_STREAM_STALL_TIMEOUT_MS);
        };

        const abortHandler = () => {
          clearStall();
          (body as Readable).destroy();
          writeStream.destroy();
          reject(new DownloadCancelledError());
        };

        if (signal) {
          if (signal.aborted) {
            abortHandler();
            return;
          }
          signal.addEventListener("abort", abortHandler);
        }

        // Track progress + keep the stall watchdog fed
        (body as Readable).on("data", (chunk) => {
          armStall();
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
        armStall();

        writeStream.on("finish", () => {
          clearStall();
          logger.info(`✅ Model downloaded successfully to ${modelPath}`);
          if (signal) {
            signal.removeEventListener("abort", abortHandler);
          }
          resolve(undefined);
        });
        writeStream.on("error", (error) => {
          clearStall();
          reject(error);
        });
        (body as Readable).on("error", (error) => {
          clearStall();
          reject(error);
        });
      });
    } else if (body[Symbol.asyncIterator]) {
      // Body is an async iterable. Drive the iterator manually so each pull can
      // race a stall timeout: a dead socket after suspend/drop produces neither
      // a chunk nor an error, so the timeout converts it into a retriable
      // failure and we abandon the iterator (which cancels the stream).
      const iterator = (
        body as AsyncIterable<Buffer | Uint8Array>
      )[Symbol.asyncIterator]();
      let stalled = false;
      try {
        for (;;) {
          let stallTimer: ReturnType<typeof setTimeout> | undefined;
          const nextPromise = iterator.next();
          nextPromise.catch(() => {});
          let step: IteratorResult<Buffer | Uint8Array>;
          try {
            step = await Promise.race([
              nextPromise,
              new Promise<never>((_, reject) => {
                stallTimer = setTimeout(() => {
                  stalled = true;
                  reject(
                    new Error(
                      `HTTP stream stalled: no data for ${HTTP_STREAM_STALL_TIMEOUT_MS}ms`,
                    ),
                  );
                }, HTTP_STREAM_STALL_TIMEOUT_MS);
              }),
            ]);
          } finally {
            if (stallTimer) clearTimeout(stallTimer);
          }

          if (step.done) break;

          if (signal?.aborted) {
            writeStream.destroy();
            throw new DownloadCancelledError();
          }

          const buffer = Buffer.isBuffer(step.value)
            ? step.value
            : Buffer.from(step.value);
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
        if (stalled) {
          try {
            await iterator.return?.();
          } catch {
            /* best effort: free the dead socket */
          }
        }
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
      // Fallback: getReader() for a WHATWG ReadableStream (bare-fetch body).
      const readableStreamBody = body as unknown as {
        getReader?: () => {
          read: () => Promise<{ done: boolean; value: Uint8Array }>;
          releaseLock: () => void;
          cancel: (reason?: unknown) => Promise<void>;
        };
      };
      const reader = readableStreamBody.getReader
        ? readableStreamBody.getReader()
        : null;
      if (reader) {
        let cancelled = false;
        try {
          for (;;) {
            // Race each read against a stall timeout. A dead socket after a
            // suspend/drop yields no data and no error; the timeout converts
            // that into a retriable failure so the caller resumes via Range.
            let stallTimer: ReturnType<typeof setTimeout> | undefined;
            const readPromise = reader.read();
            // Avoid an unhandled rejection if the read loses the race.
            readPromise.catch(() => {});
            let result: { done: boolean; value: Uint8Array };
            try {
              result = await Promise.race([
                readPromise,
                new Promise<never>((_, reject) => {
                  stallTimer = setTimeout(() => {
                    cancelled = true;
                    reject(
                      new Error(
                        `HTTP stream stalled: no data for ${HTTP_STREAM_STALL_TIMEOUT_MS}ms`,
                      ),
                    );
                  }, HTTP_STREAM_STALL_TIMEOUT_MS);
                }),
              ]);
            } finally {
              if (stallTimer) clearTimeout(stallTimer);
            }

            const { done, value } = result;
            if (done) break;

            if (signal?.aborted) {
              cancelled = true;
              throw new DownloadCancelledError();
            }

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
          if (cancelled) {
            try {
              await reader.cancel();
            } catch {
              /* best effort: free the dead socket */
            }
          }
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

const DEFAULT_HTTP_DOWNLOAD_MAX_RETRIES = 5;
const HTTP_RETRY_BASE_DELAY_MS = 500;
const LIFECYCLE_WAIT_POLL_MS = 200;
const LIFECYCLE_WAIT_MAX_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A mid-stream socket/body error, a connection failure (HTTP status 0, no
 * response), or our own resume-triggered abort is recoverable by resuming from
 * the partial. A real HTTP status (4xx/5xx) or a missing/unreadable body is not.
 *
 * `DownloadCancelledError` is intentionally NOT excluded here: this is only
 * reached after the caller's consumer-cancel gate, so a cancellation at this
 * point is our per-attempt abort (resume interrupt), which must be retried.
 */
function isResumableTransferError(error: unknown): boolean {
  if (
    error instanceof NoResponseBodyError ||
    error instanceof ResponseBodyNotReadableError ||
    error instanceof PartialDownloadOfflineError
  ) {
    return false;
  }
  if (error instanceof HTTPError) return error.httpStatus === 0;
  return error instanceof Error;
}

/**
 * Block until the runtime is active again before retrying. After a suspend the
 * socket is dead and the process can't service the transfer; resuming the fetch
 * only makes sense once `resume()` has run. Bounded and abort-aware.
 */
async function waitForLifecycleActive(signal?: AbortSignal): Promise<void> {
  if (getLifecycleState() === "active") return;
  const start = Date.now();
  while (getLifecycleState() !== "active") {
    if (signal?.aborted) throw new DownloadCancelledError();
    if (Date.now() - start > LIFECYCLE_WAIT_MAX_MS) return;
    await sleep(LIFECYCLE_WAIT_POLL_MS);
  }
}

/**
 * Run `performHttpDownload` with bounded retry. On a recoverable interruption
 * (mid-stream socket drop, or a dead socket after suspend/network loss) it
 * waits for the runtime to be active and re-issues the request, which resumes
 * from the on-disk partial via a Range header. No consumer-side babysitting.
 *
 * Each attempt runs on its own AbortController that is aborted either by the
 * consumer `signal` (a real cancel — terminal) or by `resume()` (a proactive
 * recovery — the in-flight socket is dead after a background, so abort and
 * range-resume immediately instead of waiting for the stall watchdog).
 */
async function performHttpDownloadWithResume(
  url: string,
  modelPath: string,
  downloadKey: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  signal?: AbortSignal,
): Promise<void> {
  const maxRetries = DEFAULT_HTTP_DOWNLOAD_MAX_RETRIES;

  let attempt = 0;
  for (;;) {
    const attemptController = new AbortController();
    const forwardCancel = () => attemptController.abort();
    if (signal) {
      if (signal.aborted) attemptController.abort();
      else signal.addEventListener("abort", forwardCancel, { once: true });
    }
    // resume() → abort this attempt so it range-resumes now, not after the stall.
    const offResume = onResume(() => attemptController.abort());

    try {
      await performHttpDownload(
        url,
        modelPath,
        downloadKey,
        progressCallback,
        attemptController.signal,
      );
      return;
    } catch (error) {
      // A real consumer cancel is terminal; anything else (resume abort, stall,
      // network error) is recoverable from the partial.
      if (signal?.aborted) {
        throw error instanceof DownloadCancelledError
          ? error
          : new DownloadCancelledError();
      }
      attempt++;
      if (attempt > maxRetries || !isResumableTransferError(error)) throw error;

      logger.warn(
        `⚠️ HTTP download interrupted (attempt ${attempt}/${maxRetries}), resuming from partial: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await waitForLifecycleActive(signal);
      await sleep(HTTP_RETRY_BASE_DELAY_MS * attempt);
    } finally {
      if (signal) signal.removeEventListener("abort", forwardCancel);
      offResume();
    }
  }
}

export async function downloadModelFromHttp(
  url: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  hooks?: DownloadHooks,
) {
  const filename = extractFilenameFromUrl(url);

  if (isArchiveUrl(url)) {
    return downloadShardedModelFromArchive(url, progressCallback, hooks);
  }

  const shardInfo = detectShardedModel(filename);

  if (shardInfo.isSharded && shardInfo.totalShards) {
    return downloadShardedModelFromHttp(url, progressCallback, hooks);
  }

  const downloadKey = createHttpDownloadKey(url);
  hooks?.onDownloadKey?.(downloadKey);
  const cacheDir = getModelsCacheDir();
  const sourceHash = generateShortHash(url);
  const modelPath = `${cacheDir}/${sourceHash}_${filename}`;

  const result = startOrJoinDownload(
    downloadKey,
    async (ctx) => {
      try {
        // Check if already cached
        const cachedPath = await validateCachedFile(
          modelPath,
          url,
          ctx.signal,
        );
        if (cachedPath) {
          hooks?.markCacheHit?.();
          ctx.setCacheHit(true);
          try {
            const stats = await fsPromises.stat(cachedPath);
            ctx.broadcastProgress({
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
          return cachedPath;
        }

        // Download the file
        hooks?.markCacheMiss?.();
        ctx.setCacheHit(false);
        await performHttpDownloadWithResume(
          url,
          modelPath,
          downloadKey,
          ctx.broadcastProgress,
          ctx.signal,
        );

        try {
          const stats = await fsPromises.stat(modelPath);
          ctx.broadcastProgress({
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

        return modelPath;
      } catch (error) {
        logger.error(
          "❌ Error downloading model:",
          error instanceof Error ? error.message : String(error),
        );

        // Check if we should delete the partial file (clearCache was requested)
        if (error instanceof DownloadCancelledError) {
          if (ctx.shouldClearCache()) {
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
        }

        const errorToThrow =
          error instanceof Error ? error : new Error(String(error));
        throw errorToThrow;
      }
    },
    progressCallback,
    hooks?.requestBinding,
  );

  return applyJoinedDownloadStats(result, hooks);
}

async function downloadShardedModelFromHttp(
  shardUrl: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  hooks?: DownloadHooks,
) {
  const config = getSDKConfig();
  const concurrency = config.httpDownloadConcurrency ?? DEFAULT_CONCURRENCY;
  const { shardUrls: shardInfos, cacheKey } =
    parsePatternBasedShardUrl(shardUrl);
  const downloadKey = `http-sharded:${cacheKey}`;
  hooks?.onDownloadKey?.(downloadKey);

  logger.info(
    `📥 HTTP sharded download: ${shardInfos.length} shards detected from ${shardUrl}`,
  );

  const shardDir = getShardedModelCacheDir(cacheKey);

  const result = startOrJoinDownload(
    downloadKey,
    async (ctx) => {
      try {
        const shardStates: ShardDownloadState[] = await Promise.all(
          shardInfos.map(async (shard, index) => {
            const shardPath = path.join(shardDir, shard.filename);
            let expectedSize = 0;

            try {
              const response = await fetch(shard.url, {
                method: "HEAD",
                signal: ctx.signal,
              });
              expectedSize = parseInt(
                response.headers.get("content-length") || "0",
              );
            } catch (error) {
              logger.warn("Failed to get shard size via HEAD request", {
                url: shard.url,
                error,
              });
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
              ctx.signal,
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

        if (shardsToDownload.length === 0) {
          hooks?.markCacheHit?.();
          ctx.setCacheHit(true);
        } else {
          hooks?.markCacheMiss?.();
          ctx.setCacheHit(false);
        }

        await downloadShardsWithConcurrency(
          shardsToDownload,
          shardStates,
          concurrency,
          ctx.signal,
          downloadKey,
          overallTotal,
          ctx.broadcastProgress,
        );

        logger.info(
          `✅ All ${shardInfos.length} shards downloaded successfully`,
        );

        await extractTensorsFromShards(shardDir, shardInfos[0]!.filename);

        return path.join(shardDir, shardInfos[0]!.filename);
      } catch (error) {
        logger.error(
          "❌ Error during sharded download:",
          error instanceof Error ? error.message : String(error),
        );

        if (error instanceof DownloadCancelledError) {
          if (ctx.shouldClearCache()) {
            logger.info("🗑️ Clearing cache - deleting partial shard files");
            try {
              await fsPromises.rm(shardDir, { recursive: true, force: true });
              logger.info(`✅ Deleted shard directory: ${shardDir}`);
            } catch (cleanupError) {
              logger.debug(
                "Failed to delete shard directory during cleanup",
                {
                  path: shardDir,
                  error: cleanupError,
                },
              );
            }
          }
        }

        throw error;
      }
    },
    progressCallback,
    hooks?.requestBinding,
  );

  return applyJoinedDownloadStats(result, hooks);
}

async function downloadShardedModelFromArchive(
  archiveUrl: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  hooks?: DownloadHooks,
) {
  const filename = extractFilenameFromUrl(archiveUrl);
  const sourceHash = generateShortHash(archiveUrl);
  const downloadKey = `http-archive:${sourceHash}`;
  hooks?.onDownloadKey?.(downloadKey);

  logger.info(`📦 HTTP archive download: ${filename}`);

  const extractDir = getShardedModelCacheDir(sourceHash);
  const archivePath = path.join(extractDir, `${sourceHash}_${filename}`);

  const result = startOrJoinDownload(
    downloadKey,
    async (ctx) => {
      try {
        await fsPromises.mkdir(extractDir, { recursive: true });

        const files = await fsPromises.readdir(extractDir);
        const shardedFile = files.find(
          (f) => detectShardedModel(String(f)).isSharded,
        );

        if (!shardedFile) {
          hooks?.markCacheMiss?.();
          ctx.setCacheHit(false);
          return downloadAndExtractArchive();
        }

        const shardFilename = String(shardedFile);
        const allShardsExist = await checkAllShardsExist(
          extractDir,
          shardFilename,
        );

        if (!allShardsExist) {
          logger.warn(`⚠️ Incomplete shards found, re-downloading archive`);
          hooks?.markCacheMiss?.();
          ctx.setCacheHit(false);
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
          hooks?.markCacheHit?.();
          ctx.setCacheHit(true);
          ctx.broadcastProgress({
            type: "modelProgress",
            downloaded: 1,
            total: 1,
            percentage: 100,
            downloadKey,
          });
          return firstShard;
        }

        logger.info(
          `📝 All shards present but tensors.txt missing, extracting tensors...`,
        );
        try {
          await extractTensorsFromShards(extractDir, shardFilename);
          logger.info(`✅ Tensors extracted successfully`);
          hooks?.markCacheHit?.();
          ctx.setCacheHit(true);
          ctx.broadcastProgress({
            type: "modelProgress",
            downloaded: 1,
            total: 1,
            percentage: 100,
            downloadKey,
          });
          return firstShard;
        } catch (error) {
          logger.warn(`Failed to extract tensors, will re-download archive`, {
            error,
          });
          hooks?.markCacheMiss?.();
          ctx.setCacheHit(false);
          return downloadAndExtractArchive();
        }
      } catch (error) {
        logger.error("❌ Error downloading/extracting archive:", error);

        if (error instanceof DownloadCancelledError) {
          if (ctx.shouldClearCache()) {
            logger.info(
              "🗑️ Clearing cache - deleting archive extract directory",
            );
            try {
              await fsPromises.rm(extractDir, {
                recursive: true,
                force: true,
              });
              logger.info(`✅ Deleted extract directory: ${extractDir}`);
            } catch (cleanupError) {
              logger.debug(
                "Failed to delete extract directory during cleanup",
                {
                  path: extractDir,
                  error: cleanupError,
                },
              );
            }
          }
        }

        throw error;
      }

      async function downloadAndExtractArchive() {
        await performHttpDownloadWithResume(
          archiveUrl,
          archivePath,
          downloadKey,
          ctx.broadcastProgress,
          ctx.signal,
        );

        logger.info(`✅ Archive downloaded, extracting to: ${extractDir}`);

        const firstShardPath = await extractAndValidateShardedArchive(
          archivePath,
          extractDir,
          ctx.signal,
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
    },
    progressCallback,
    hooks?.requestBinding,
  );

  return applyJoinedDownloadStats(result, hooks);
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

        await performHttpDownloadWithResume(
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
