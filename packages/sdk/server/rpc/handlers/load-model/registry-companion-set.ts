import type { ModelProgressUpdate } from "@/schemas";
import type { RegistryItem } from "@/models/registry";
import { promises as fsPromises } from "bare-fs";
import type { AbortSignal } from "bare-abort-controller";
import {
  getModelsCacheDir,
  getCompanionSetPath,
  getCompanionSetCacheDir,
  getSingleFileCachePath,
  generateShortHash,
  calculatePercentage,
} from "@/server/utils";
import { measureChecksum } from "@/server/utils/checksum";
import { validateAndJoinPath } from "@/server/utils/path-security";
import {
  buildBlobBinding,
  downloadSingleFileFromRegistry,
  validateCachedFile,
} from "./registry-download-utils";
import {
  DownloadCancelledError,
  RegistryDownloadFailedError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";
import type { DownloadHooks } from "./types";

type CompanionSetMetadata = NonNullable<RegistryItem["companionSet"]>;
type CompanionSetMetadataEntry = CompanionSetMetadata["files"][number];

const logger = getServerLogger();

export interface DownloadCompanionSetOptions {
  companionSet: CompanionSetMetadata;
  downloadKey: string;
  progressCallback?: ((progress: ModelProgressUpdate) => void) | undefined;
  signal?: AbortSignal | undefined;
  hooks?: DownloadHooks | undefined;
  shouldClearCache?: (() => boolean) | undefined;
}

/**
 * Download a companion set from the registry, placing files directly
 * into their canonical layout at `sets/<setKey>/<targetName>`.
 *
 * Returns the path to the primary file.
 */
export async function downloadCompanionSetFromRegistry(
  options: DownloadCompanionSetOptions,
): Promise<string> {
  const {
    companionSet,
    downloadKey,
    progressCallback,
    signal,
    hooks,
    shouldClearCache,
  } = options;

  const { files, setKey, primaryKey } = companionSet;
  validateCompanionSetMetadata(files, primaryKey);

  const primaryEntry = files.find((f) => f.key === primaryKey)!;
  const primaryRegistryPath = primaryEntry.registryPath;

  if (isLegacyOnnxSet(files)) {
    const legacyPath = await checkLegacyOnnxCache(primaryRegistryPath, files, hooks);
    if (legacyPath) {
      logger.info(`✅ Using legacy ONNX cache for companion set: ${legacyPath}`);
      hooks?.markCacheHit?.();
      emitFinalProgress(progressCallback, downloadKey, setKey, files);
      return legacyPath;
    }
  }

  // Legacy flat-cache compatibility for Bergamot-style companion sets.
  // This is valid only for families whose runtime still works with explicit
  // per-file absolute paths; it is not a generic rule for all companion sets.
  if (!isLegacyOnnxSet(files)) {
    const flatPath = await checkLegacyFlatCache(files, primaryKey, hooks);
    if (flatPath) {
      logger.info(`✅ Using legacy flat cache for companion set: ${flatPath}`);
      hooks?.markCacheHit?.();
      emitFinalProgress(progressCallback, downloadKey, setKey, files);
      return flatPath;
    }
  }

  // Check canonical companion set cache
  const validatedFiles = new Set<string>();

  for (const file of files) {
    const filePath = getCompanionSetPath(setKey, file.targetName);
    const cached = await validateCachedFile(
      filePath,
      file.targetName,
      file.expectedSize,
      file.sha256Checksum,
      hooks,
    );
    if (cached) {
      validatedFiles.add(file.key);
    }
  }

  if (validatedFiles.size === files.length) {
    logger.info(`✅ All companion set files cached`);
    hooks?.markCacheHit?.();
    emitFinalProgress(progressCallback, downloadKey, setKey, files);
    return getCompanionSetPath(setKey, primaryEntry.targetName);
  }

  // Download missing files
  hooks?.markCacheMiss?.();
  const overallTotal = files.reduce((sum, f) => sum + f.expectedSize, 0);
  let overallDownloaded = 0;

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const filePath = getCompanionSetPath(setKey, file.targetName);

      if (validatedFiles.has(file.key)) {
        overallDownloaded += file.expectedSize;
        continue;
      }

      const fileProgressCallback = progressCallback
        ? (progress: ModelProgressUpdate) => {
            const currentOverall = overallDownloaded + progress.downloaded;
            progressCallback({
              ...progress,
              downloadKey,
              fileSetInfo: {
                setKey,
                currentFile: file.targetName,
                fileIndex: i + 1,
                totalFiles: files.length,
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

      const blobBinding = file.blobCoreKey
        ? buildBlobBinding(file)
        : undefined;

      await downloadSingleFileFromRegistry(
        file.registryPath,
        file.registrySource,
        filePath,
        file.targetName,
        downloadKey,
        file.expectedSize,
        file.sha256Checksum,
        fileProgressCallback,
        signal,
        blobBinding,
        hooks,
      );

      overallDownloaded += file.expectedSize;
    }
  } catch (error) {
    if (error instanceof DownloadCancelledError && shouldClearCache?.()) {
      try {
        await fsPromises.rm(getCompanionSetCacheDir(setKey), {
          recursive: true,
          force: true,
        });
      } catch (cleanupError) {
        logger.debug("Failed to delete companion set cache during cleanup", {
          setKey,
          error: cleanupError,
        });
      }
    }
    throw error;
  }

  emitFinalProgress(progressCallback, downloadKey, setKey, files);
  return getCompanionSetPath(setKey, primaryEntry.targetName);
}

function emitFinalProgress(
  progressCallback: ((progress: ModelProgressUpdate) => void) | undefined,
  downloadKey: string,
  setKey: string,
  files: readonly CompanionSetMetadataEntry[],
): void {
  if (!progressCallback) return;

  const overallTotal = files.reduce((sum, f) => sum + f.expectedSize, 0);
  const lastFile = files[files.length - 1]!;

  progressCallback({
    type: "modelProgress",
    downloaded: overallTotal,
    total: overallTotal,
    percentage: 100,
    downloadKey,
    fileSetInfo: {
      setKey,
      currentFile: lastFile.targetName,
      fileIndex: files.length,
      totalFiles: files.length,
      overallDownloaded: overallTotal,
      overallTotal,
      overallPercentage: 100,
    },
  });
}

function validateCompanionSetMetadata(
  files: readonly CompanionSetMetadataEntry[],
  primaryKey: string,
): void {
  if (!files.some((f) => f.key === primaryKey)) {
    throw new RegistryDownloadFailedError(
      `Companion set missing primary file (key: ${primaryKey})`,
    );
  }

  const targetNames = new Set<string>();
  for (const file of files) {
    if (targetNames.has(file.targetName)) {
      throw new RegistryDownloadFailedError(
        `Companion set has duplicate targetName "${file.targetName}"`,
      );
    }
    targetNames.add(file.targetName);
  }
}

function isLegacyOnnxSet(
  files: readonly CompanionSetMetadataEntry[],
): boolean {
  return files.some(
    (f) => f.primary === true && f.targetName.endsWith(".onnx"),
  );
}

/**
 * Check if a complete legacy ONNX cache exists for a companion set.
 * Read-only probe: does not create legacy cache directories.
 */
async function checkLegacyOnnxCache(
  primaryRegistryPath: string,
  files: readonly CompanionSetMetadataEntry[],
  hooks?: DownloadHooks,
): Promise<string | null> {
  const cacheKey = generateShortHash(primaryRegistryPath);
  let primaryPath: string | null = null;

  for (const file of files) {
    const filePath = getLegacyOnnxPath(cacheKey, file.targetName);

    try {
      const stats = await fsPromises.stat(filePath);
      if (stats.size !== file.expectedSize) return null;

      if (file.sha256Checksum && file.sha256Checksum.length === 64) {
        const checksum = await measureChecksum(filePath, hooks);
        if (checksum !== file.sha256Checksum) return null;
      }
    } catch {
      return null;
    }

    if (file.primary === true) {
      primaryPath = filePath;
    }
  }

  return primaryPath;
}

function getLegacyOnnxPath(cacheKey: string, filename: string): string {
  const baseCache = getModelsCacheDir();
  return validateAndJoinPath(baseCache, "onnx", cacheKey, filename);
}

/**
 * Check if all companion files exist in the flat single-file cache.
 */
async function checkLegacyFlatCache(
  files: readonly CompanionSetMetadataEntry[],
  primaryKey: string,
  hooks?: DownloadHooks,
): Promise<string | null> {
  let primaryPath: string | null = null;

  for (const file of files) {
    const flatPath = getSingleFileCachePath(file.registryPath);

    try {
      const stats = await fsPromises.stat(flatPath);
      if (stats.size !== file.expectedSize) return null;

      if (file.sha256Checksum && file.sha256Checksum.length === 64) {
        const checksum = await measureChecksum(flatPath, hooks);
        if (checksum !== file.sha256Checksum) return null;
      }
    } catch {
      return null;
    }

    if (file.key === primaryKey) {
      primaryPath = flatPath;
    }
  }

  return primaryPath;
}
