import { models, getModelByPath } from "@/models/registry/models";
import {
  hyperdriveUrlSchema,
  registryUrlSchema,
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
import { downloadModelFromRegistry } from "./registry";
import {
  downloadModelFromHttpWithStats,
  downloadModelFromHyperdriveWithStats,
  downloadModelFromRegistryWithStats,
} from "./download-stats";
import type { ResolveResult, DownloadResult, DownloadHooks } from "./types";
import {
  ModelLoadFailedError,
  ModelNotFoundError,
  SeedingNotSupportedError,
} from "@/utils/errors-server";
import { validateAndJoinPath } from "@/server/utils/path-security";
import { getServerLogger } from "@/logging";
import { modelInputToSrcSchema } from "@/schemas";

type ResolveMode = "base" | "stats";

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
  const cachedPath = validateAndJoinPath(cacheDir, modelIdOrPath);

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

function isDownloadResult(value: string | DownloadResult): value is DownloadResult {
  return value !== null && typeof value === "object" && "path" in value;
}

function buildResult(
  pathOrResult: string | DownloadResult,
  sourceType: ResolveResult["sourceType"],
): ResolveResult {
  if (isDownloadResult(pathOrResult)) {
    return pathOrResult.stats
      ? { path: pathOrResult.path, sourceType, downloadStats: pathOrResult.stats }
      : { path: pathOrResult.path, sourceType };
  }
  return { path: pathOrResult, sourceType };
}

async function resolveModelPathCore(
  modelSrc: unknown,
  progressCallback: ((progress: ModelProgressUpdate) => void) | undefined,
  seed: boolean | undefined,
  mode: ResolveMode,
  hooks?: DownloadHooks,
): Promise<ResolveResult> {
  const srcString = modelInputToSrcSchema.parse(modelSrc);

  // Parse hyperdrive URLs if present
  let hyperdriveKey: string | undefined;
  let actualModelSrc = srcString;

  if (srcString.startsWith("pear://")) {
    const { key, path: pathValue } = hyperdriveUrlSchema.parse(srcString);
    hyperdriveKey = key;
    actualModelSrc = pathValue;
  }

  // Registry source
  if (srcString.startsWith("registry://")) {
    const { registryPath, registrySource } = registryUrlSchema.parse(srcString);
    logger.info(`Loading from registry: ${registryPath}`);

    // Look up model metadata for checksum validation
    const modelMetadata = getModelByPath(registryPath);
    const expectedChecksum = modelMetadata?.sha256Checksum;

    const result = mode === "stats"
      ? await downloadModelFromRegistryWithStats(
          registryPath, registrySource, progressCallback, expectedChecksum, hooks,
        )
      : await downloadModelFromRegistry(
          registryPath, registrySource, progressCallback, expectedChecksum, hooks,
        );
    logger.info(`Loaded Model to ${isDownloadResult(result) ? result.path : result}`);
    return buildResult(result, "registry");
  }

  // Validate seeding is only used with hyperdrive models
  if (seed && !hyperdriveKey) {
    throw new SeedingNotSupportedError();
  }

  // HTTP source
  if (
    actualModelSrc.startsWith("http://") ||
    actualModelSrc.startsWith("https://")
  ) {
    logger.info(`Loading from HTTP URL: ${actualModelSrc}`);

    const result = mode === "stats"
      ? await downloadModelFromHttpWithStats(actualModelSrc, progressCallback, hooks)
      : await downloadModelFromHttp(actualModelSrc, progressCallback, hooks);
    logger.info(`Loaded Model to ${isDownloadResult(result) ? result.path : result}`);
    return buildResult(result, "http");
  }

  // Hyperdrive source
  if (hyperdriveKey) {
    logger.info(`Loading from hyperdrive: ${hyperdriveKey}`);

    const result = mode === "stats"
      ? await downloadModelFromHyperdriveWithStats(
          hyperdriveKey, actualModelSrc, seed, progressCallback, hooks,
        )
      : await downloadModelFromHyperdrive(
          hyperdriveKey, actualModelSrc, seed, progressCallback, hooks,
        );
    return buildResult(result, "hyperdrive");
  }

  // Filesystem source (local files, cached files)
  let resolvedPath: string;
  if (actualModelSrc.includes("/") || actualModelSrc.includes("\\")) {
    if (isArchivePath(actualModelSrc)) {
      logger.info(`Extracting local archive: ${actualModelSrc}`);
      const archiveHash = generateShortHash(actualModelSrc);
      const extractDir = getShardedModelCacheDir(archiveHash);
      resolvedPath = await extractAndValidateShardedArchive(
        actualModelSrc,
        extractDir,
      );
    } else {
      resolvedPath = actualModelSrc;
    }
  } else {
    resolvedPath = await resolveLocalOrCachedFile(actualModelSrc);
  }

  return { path: resolvedPath, sourceType: "filesystem" };
}

export async function resolveModelPath(
  modelSrc: unknown,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  seed?: boolean,
  hooks?: DownloadHooks,
): Promise<string> {
  const result = await resolveModelPathCore(modelSrc, progressCallback, seed, "base", hooks);
  return result.path;
}

export async function resolveModelPathWithStats(
  modelSrc: unknown,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  seed?: boolean,
  hooks?: DownloadHooks,
): Promise<ResolveResult> {
  return resolveModelPathCore(modelSrc, progressCallback, seed, "stats", hooks);
}
