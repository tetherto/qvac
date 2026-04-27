import type { ModelProgressUpdate } from "@/schemas";
import type { QVACBlobBinding } from "@qvac/registry-client";
import { promises as fsPromises } from "bare-fs";
import path from "bare-path";
import type { AbortSignal } from "bare-abort-controller";
import {
  measureChecksum,
  calculatePercentage,
} from "@/server/utils";
import { getRegistryClient } from "@/server/bare/registry/registry-client";
import { getSDKConfig } from "@/server/bare/registry/config-registry";
import { buildRegistryClientOptions } from "./registry-client-options";
import {
  ChecksumValidationFailedError,
  DownloadCancelledError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";
import type { DownloadHooks } from "./types";

const logger = getServerLogger();

export {
  DEFAULT_REGISTRY_STREAM_TIMEOUT_MS,
  buildRegistryClientOptions,
} from "./registry-client-options";
export type { RegistryClientDownloadOptions } from "./registry-client-options";

export function buildBlobBinding(meta: {
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
export async function validateCachedFile(
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

    if (localSize === expectedSize) {
      logger.info(`✅ Model cached with correct size: ${modelPath}`);

      if (expectedChecksum && expectedChecksum.length === 64) {
        const checksum = await measureChecksum(modelPath, hooks);
        if (checksum !== expectedChecksum) {
          throw new ChecksumValidationFailedError(
            `${modelFileName}. Expected: ${expectedChecksum}. Actual: ${checksum}. File may be corrupted`,
          );
        }
      }
      logger.info(`✅ Model already cached and validated: ${modelPath}`);
      return modelPath;
    }

    logger.warn(
      `🗑️ Removing incomplete cached file (expected ${expectedSize}, got ${localSize}): ${modelPath}`,
    );
    await fsPromises.unlink(modelPath);
    return null;
  } catch (error) {
    if (error instanceof ChecksumValidationFailedError) {
      logger.warn(`🗑️ Removing corrupted cached file: ${modelPath}`);
      await fsPromises.unlink(modelPath).catch(() => {});
    }
    return null;
  }
}

/**
 * Download a single file from the registry to filesystem.
 * When blobBinding is provided, uses direct blob download (skips metadata sync).
 * Otherwise falls back to metadata-based downloadModel.
 */
export async function downloadSingleFileFromRegistry(
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
  hooks?: DownloadHooks,
): Promise<void> {
  if (signal?.aborted) {
    throw new DownloadCancelledError();
  }

  const client = await getRegistryClient();

  const dir = path.dirname(modelPath);
  await fsPromises.mkdir(dir, { recursive: true });

  const onProgress = progressCallback
    ? (progress: { downloaded: number; total: number }) => {
        const total = progress.total || expectedSize || progress.downloaded;
        progressCallback({
          type: "modelProgress",
          downloaded: progress.downloaded,
          total,
          percentage: total > 0
            ? calculatePercentage(progress.downloaded, total)
            : 0,
          downloadKey,
        });
      }
    : undefined;

  const clientOptions = buildRegistryClientOptions({
    sdkConfig: getSDKConfig(),
    outputFile: modelPath,
    onProgress,
    signal,
  });

  if (blobBinding) {
    logger.info(`📥 Downloading blob directly: ${modelFileName}`);
    await client.downloadBlob(blobBinding, clientOptions);
  } else {
    logger.info(`📥 Downloading from registry: ${registryPath}`);
    await client.downloadModel(registryPath, registrySource, clientOptions);
  }

  logger.info(`✅ Downloaded to ${modelPath}`);

  const stats = await fsPromises.stat(modelPath);
  if (expectedSize && stats.size !== expectedSize) {
    await fsPromises.unlink(modelPath).catch(() => {});
    throw new ChecksumValidationFailedError(
      `${modelFileName}. File size mismatch: expected ${expectedSize}, got ${stats.size}`,
    );
  }

  if (expectedChecksum && expectedChecksum.length === 64) {
    const checksum = await measureChecksum(modelPath, hooks);
    if (checksum !== expectedChecksum) {
      await fsPromises.unlink(modelPath);
      throw new ChecksumValidationFailedError(
        `${modelFileName}. Expected: ${expectedChecksum}. Actual: ${checksum}`,
      );
    }
    logger.info(`✅ Checksum validated for ${modelFileName}`);
  }

  if (progressCallback) {
    progressCallback({
      type: "modelProgress",
      downloaded: stats.size,
      total: stats.size,
      percentage: 100,
      downloadKey,
    });
  }
}
