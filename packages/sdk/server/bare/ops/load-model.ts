import {
  loadModelServerParamsSchema,
  normalizeModelType,
  type LoadModelServerParams,
  type CanonicalModelType,
} from "@/schemas";
import type { LoadTimingStats } from "@/profiling/types";
import { nowMs } from "@/profiling/clock";
import {
  isModelLoaded,
  registerModel,
  type AnyModel,
} from "@/server/bare/registry/model-registry";
import {
  startLogBuffering,
  stopLogBufferingWithTimeout,
} from "@/server/bare/registry/logging-stream-registry";
import {
  detectShardedModel,
  generateShardFilenames,
  validateShardedModelCache,
} from "@/server/utils";
import {
  PluginNotFoundError,
  ModelFileNotFoundError,
  ModelFileNotFoundInDirError,
  ModelFileLocateFailedError,
} from "@/utils/errors-server";
import { getPlugin } from "@/server/plugins";
import { promises as fsPromises } from "bare-fs";
import path from "bare-path";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export interface LoadModelResult {
  timing?: LoadTimingStats;
}

export async function loadModel(
  params: LoadModelServerParams,
  options?: { collectTiming?: boolean },
): Promise<LoadModelResult> {
  const { modelId, modelPath, options: modelOptions, artifacts, modelName } =
    loadModelServerParamsSchema.parse(params);
  const { modelConfig, modelType: rawModelType } = modelOptions;

  // Normalize modelType to canonical form (handles aliases and custom types)
  const modelType = normalizeModelType(rawModelType);

  // Check if model is already loaded
  if (isModelLoaded(modelId)) {
    logger.info(`${modelType} model ${modelId} is already loaded`);
    return {};
  }

  // Detect if sharded model
  const modelFileName = path.basename(modelPath);
  const shardInfo = detectShardedModel(modelFileName);
  const isShardedModel = shardInfo.isSharded;

  const plugin = getPlugin(modelType);
  if (!plugin) {
    throw new PluginNotFoundError(modelType);
  }
  if (isShardedModel) {
    // For sharded models, validate all shards and tensors.txt exist
    const shardDir = path.dirname(modelPath);
    const isValid = await validateShardedModelCache(shardDir, modelFileName);

    if (!isValid) {
      const numberedShards = generateShardFilenames(modelFileName);
      throw new ModelFileNotFoundError(
        `Missing shards or ${shardInfo.baseFilename}.tensors.txt. Expected ${numberedShards.length} shard files + tensors.txt in ${shardDir}`,
      );
    }
  } else if (!plugin.skipPrimaryModelPathValidation) {
    // For non-sharded models, validate single file exists
    try {
      const modelDir = path.dirname(modelPath);
      const modelFile = path.basename(modelPath);

      const files = (await fsPromises.readdir(modelDir)) as string[];

      if (!files.includes(modelFile)) {
        throw new ModelFileNotFoundInDirError(modelFile, modelDir, modelType);
      }
    } catch (error) {
      logger.error(
        `Error reading ${modelType} model directory:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new ModelFileLocateFailedError(modelType, modelPath, error);
    }
  }

  logger.info(`${modelType}: Loading model ${modelId}...`);
  startLogBuffering(modelId);

  try {
    const initStart = options?.collectTiming ? nowMs() : 0;

    const result = plugin.createModel({
      modelId,
      modelPath,
      modelConfig: modelConfig,
      modelName,
      artifacts,
    }) as { model: AnyModel };

    await result.model.load(false);

    const modelInitializationTimeMs = options?.collectTiming
      ? nowMs() - initStart
      : undefined;

    logger.info(`${modelType} model ${modelId} loaded`);

    registerModel(modelId, {
      model: result.model,
      path: modelPath,
      config: modelConfig,
      modelType: modelType as CanonicalModelType,
      name: modelName,
    });

    return modelInitializationTimeMs !== undefined
      ? { timing: { modelInitializationTimeMs } }
      : {};
  } finally {
    stopLogBufferingWithTimeout(modelId);
  }
}
