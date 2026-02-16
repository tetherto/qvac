import {
  loadModelServerParamsSchema,
  ModelType,
  normalizeModelType,
  type LoadModelServerParams,
  type CanonicalModelType,
} from "@/schemas";
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
  ESpeakDataPathRequiredError,
  ModelLoadFailedError,
  PluginNotFoundError,
  ModelFileNotFoundError,
  ModelFileNotFoundInDirError,
  ModelFileLocateFailedError,
} from "@/utils/errors-server";
import { getPlugin } from "@/server/plugins";
import type FilesystemDL from "@qvac/dl-filesystem";
import { promises as fsPromises } from "bare-fs";
import path from "bare-path";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export async function loadModel(params: LoadModelServerParams) {
  const {
    modelId,
    modelPath,
    options,
    projectionModelPath,
    vadModelPath,
    ttsConfigModelPath,
    eSpeakDataPath,
    detectorModelPath,
    modelName,
  } = loadModelServerParamsSchema.parse(params);
  const { modelConfig, modelType: rawModelType } = options;

  // Normalize modelType to canonical form (handles aliases and custom types)
  const modelType = normalizeModelType(rawModelType);

  // Check if model is already loaded
  if (isModelLoaded(modelId)) {
    logger.info(`${modelType} model ${modelId} is already loaded`);
    return;
  }

  // Detect if sharded model
  const modelFileName = path.basename(modelPath);
  const shardInfo = detectShardedModel(modelFileName);
  const isShardedModel = shardInfo.isSharded;

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
  } else {
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

  // Model-type-specific validation
  if (modelType === ModelType.onnxTts && !eSpeakDataPath) {
    throw new ESpeakDataPathRequiredError();
  }
  if (modelType === ModelType.onnxOcr && !detectorModelPath) {
    throw new ModelLoadFailedError(
      "Detector model required for OCR. Use a hyperdrive source or provide detectorModelSrc",
    );
  }

  const plugin = getPlugin(modelType);
  if (!plugin) {
    throw new PluginNotFoundError(modelType);
  }

  // Build artifacts map for plugin
  const artifacts: Record<string, string> = {};
  if (projectionModelPath)
    artifacts["projectionModelPath"] = projectionModelPath;
  if (vadModelPath) artifacts["vadModelPath"] = vadModelPath;
  if (ttsConfigModelPath) artifacts["ttsConfigModelPath"] = ttsConfigModelPath;
  if (eSpeakDataPath) artifacts["eSpeakDataPath"] = eSpeakDataPath;
  if (detectorModelPath) artifacts["detectorModelPath"] = detectorModelPath;

  const result = plugin.createModel({
    modelId,
    modelPath,
    modelConfig: modelConfig as Record<string, unknown>,
    modelName,
    artifacts: Object.keys(artifacts).length > 0 ? artifacts : undefined,
  }) as { model: AnyModel; loader: FilesystemDL };

  logger.info(`${modelType}: Loading model ${modelId}...`);

  startLogBuffering(modelId);

  await result.model.load(false);
  logger.info(`${modelType} model ${modelId} loaded`);

  stopLogBufferingWithTimeout(modelId);

  registerModel(modelId, {
    model: result.model,
    path: modelPath,
    config: modelConfig,
    modelType: modelType as CanonicalModelType,
    name: modelName,
    loader: result.loader,
  });
}
