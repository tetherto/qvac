import type { ModelProgressUpdate, HttpDownloadEntry } from "@/schemas";
import fs, { promises as fsPromises } from "bare-fs";
import { Readable, type Writable } from "bare-stream";
import fetch from "bare-fetch";
import { AbortController, type AbortSignal } from "bare-abort-controller";
import { getModelsCacheDir, generateShortHash } from "@/server/utils";
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
  ResponseBodyNotReadableError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

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

    // Get expected size from HEAD request
    let expectedSize = 0;
    try {
      const response = await fetch(url, {
        method: "HEAD",
        ...(signal && { signal }),
      });
      expectedSize = parseInt(response.headers.get("content-length") || "0");
    } catch (error) {
      logger.warn(
        `⚠️ Could not get expected file size from HEAD request, will re-download: ${String(error)}`,
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
  } catch {
    // File doesn't exist
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

  // Make the fetch request
  const response = await fetch(url, {
    method: "GET",
    headers,
    ...(signal && { signal }),
    // bare-fetch automatically follows redirects
  });

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
      const freshResponse = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "qvac-sdk/1.0",
        },
        ...(signal && { signal }),
      });

      if (!freshResponse.ok) {
        throw new HTTPError(freshResponse.status, freshResponse.statusText);
      }

      // Use the fresh response
      Object.assign(response, freshResponse);
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
            percentage:
              totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0,
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
            percentage:
              totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0,
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
                percentage:
                  totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0,
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
  const downloadKey = createHttpDownloadKey(url);

  // Check if already downloading
  const existing = getActiveDownload(downloadKey);
  if (existing) {
    logger.info(`📥 Reusing existing download for: ${downloadKey}`);
    return existing.promise;
  }

  const cacheDir = getModelsCacheDir();
  const sourceHash = generateShortHash(url);
  const filename = extractFilenameFromUrl(url);
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
          } catch {
            // Ignore stat errors, file exists but might not be readable
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
        } catch {
          // Ignore stat errors
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
          } catch {
            // Ignore cleanup errors
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
