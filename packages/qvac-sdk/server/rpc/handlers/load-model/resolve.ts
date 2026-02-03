import { models } from "@/models/hyperdrive/models";
import {
  hyperdriveUrlSchema,
  SUPPORTED_ARCHIVE_EXTENSIONS,
  type ModelProgressUpdate,
} from "@/schemas";
import {
  getModelsCacheDir,
  getShardedModelCacheDir,
  generateShortHash,
  extractAndValidateShardedArchive,
} from "@/server/utils";
import { promises as fsPromises } from "bare-fs";
import path from "bare-path";
import { downloadModelFromHttp } from "./http";
import { downloadModelFromHyperdrive } from "./hyperdrive";
import {
  ModelLoadFailedError,
  ModelNotFoundError,
  SeedingNotSupportedError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

function isArchivePath(filePath: string) {
  const filename = path.basename(filePath).toLowerCase();
  return SUPPORTED_ARCHIVE_EXTENSIONS.some((ext) => filename.endsWith(ext));
}

/**
 * Resolves a local file path or cached file
 */
async function resolveLocalOrCachedFile(modelIdOrPath: string) {
  // Check if it's a hex string (arbitrary hyperdrive key)
  const isHexString = /^[0-9a-fA-F]{64}$/.test(modelIdOrPath);
  if (isHexString) {
    throw new ModelLoadFailedError(
      `Direct hyperdrive keys not supported. Use hyperdriveKey parameter instead. Example: loadModel("model.gguf", "${modelIdOrPath}")`,
    );
  }

  // Check if it's a cached file or local file
  const cacheDir = getModelsCacheDir();
  const cachedPath = path.join(cacheDir, modelIdOrPath);

  try {
    await fsPromises.access(cachedPath);
    logger.info(`Loading cached model: ${cachedPath}`);

    // Check if cached file is an archive
    if (isArchivePath(cachedPath)) {
      logger.info(`Extracting cached archive: ${cachedPath}`);
      const archiveHash = generateShortHash(cachedPath);
      const extractDir = getShardedModelCacheDir(archiveHash);
      const extractedPath = await extractAndValidateShardedArchive(
        cachedPath,
        extractDir,
      );
      return extractedPath;
    }

    return cachedPath;
  } catch {
    // Try as local file in current directory
    try {
      await fsPromises.access(modelIdOrPath);
      logger.info(`Loading local file: ${modelIdOrPath}`);

      // Check if local file is an archive
      if (isArchivePath(modelIdOrPath)) {
        logger.info(`Extracting local archive: ${modelIdOrPath}`);
        const archiveHash = generateShortHash(modelIdOrPath);
        const extractDir = getShardedModelCacheDir(archiveHash);
        const extractedPath = await extractAndValidateShardedArchive(
          modelIdOrPath,
          extractDir,
        );
        return extractedPath;
      }

      return modelIdOrPath;
    } catch {
      // Invalid model ID - provide helpful error
      const availableModels = models.map((m) => m.modelId);
      throw new ModelNotFoundError(
        `${modelIdOrPath}". Available models: ${availableModels.join(", ")}`,
      );
    }
  }
}

import { modelInputToSrcSchema } from "@/schemas";

export async function resolveModelPath(
  modelSrc: unknown,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  seed?: boolean,
): Promise<string> {
  // Extract src and validate using Zod schema transform
  const srcString = modelInputToSrcSchema.parse(modelSrc);

  // Parse hyperdrive URLs if present
  let hyperdriveKey: string | undefined;
  let actualModelSrc = srcString;

  if (srcString.startsWith("pear://")) {
    const { key, path } = hyperdriveUrlSchema.parse(srcString);
    hyperdriveKey = key;
    actualModelSrc = path;
  }
  let actualPath: string;

  // Validate seeding is only used with hyperdrive models
  if (seed && !hyperdriveKey) {
    throw new SeedingNotSupportedError();
  }

  // Check if it's an HTTP/HTTPS URL
  if (
    actualModelSrc.startsWith("http://") ||
    actualModelSrc.startsWith("https://")
  ) {
    logger.info(`Loading from HTTP URL: ${actualModelSrc}`);
    actualPath = await downloadModelFromHttp(actualModelSrc, progressCallback);
    logger.info(`Loaded Model to ${actualPath}`);
  } else if (hyperdriveKey) {
    // Direct hyperdrive loading
    logger.info(`Loading from hyperdrive: ${hyperdriveKey}`);
    actualPath = await downloadModelFromHyperdrive(
      hyperdriveKey,
      actualModelSrc,
      seed,
      progressCallback,
    );
  } else if (actualModelSrc.includes("/") || actualModelSrc.includes("\\")) {
    // Handle file paths (absolute or relative with slashes)

    // Check if it's a local archive file
    if (isArchivePath(actualModelSrc)) {
      logger.info(`Extracting local archive: ${actualModelSrc}`);
      const archiveHash = generateShortHash(actualModelSrc);
      const extractDir = getShardedModelCacheDir(archiveHash);
      actualPath = await extractAndValidateShardedArchive(
        actualModelSrc,
        extractDir,
      );
    } else {
      actualPath = actualModelSrc;
    }
  } else {
    // Handle local files and cached files
    actualPath = await resolveLocalOrCachedFile(actualModelSrc);
  }

  return actualPath;
}
