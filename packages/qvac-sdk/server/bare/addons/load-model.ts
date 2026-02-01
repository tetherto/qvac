import {
  loadModelServerParamsSchema,
  type EmbedConfig,
  type LlmConfig,
  type LoadModelServerParams,
  type WhisperConfig,
} from "@/schemas";
import {
  createEmbeddingsModel,
  createLlmModel,
} from "@/server/bare/addons/llamacpp";
import { createNmtModel } from "@/server/bare/addons/translation";
import { createTtsModel } from "@/server/bare/addons/tts";
import { createWhisperModel } from "@/server/bare/addons/whispercpp";
import {
  isModelLoaded,
  registerModel,
  type AnyModel,
} from "@/server/bare/registry/model-registry";
import {
  startLogBuffering,
  stopLogBufferingWithTimeout,
} from "@/server/bare/registry/logging-stream-registry";
import { detectShardedModel, generateShardFilenames } from "@/server/utils";
import {
  ESpeakDataPathRequiredError,
  UnknownModelTypeError,
  ModelFileNotFoundError,
  ModelFileNotFoundInDirError,
  ModelFileLocateFailedError,
} from "@/utils/errors-server";
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
    modelName,
  } = loadModelServerParamsSchema.parse(params);
  const { modelConfig, modelType } = options;

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
    // For sharded models, validate all required files exist
    const shardDir = path.dirname(modelPath);
    const allRequiredFiles = generateShardFilenames(modelFileName);

    for (const shardFile of allRequiredFiles) {
      const shardPath = path.join(shardDir, shardFile);
      try {
        await fsPromises.access(shardPath);
      } catch (error) {
        throw new ModelFileNotFoundError(
          `${shardFile}. Expected ${allRequiredFiles.length} files (shards + companion files) in ${shardDir}`,
          error,
        );
      }
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

  let result: { model: AnyModel; loader: FilesystemDL };
  switch (modelType) {
    case "llm":
      result = createLlmModel(
        modelId,
        modelPath,
        modelConfig as LlmConfig,
        projectionModelPath,
      );
      break;
    case "whisper":
      result = createWhisperModel(
        modelId,
        modelPath,
        modelConfig as WhisperConfig,
        vadModelPath,
      );
      break;
    case "embeddings":
      result = createEmbeddingsModel(
        modelId,
        modelPath,
        modelConfig as EmbedConfig,
      );
      break;

    case "nmt":
      result = createNmtModel(modelId, modelPath, modelConfig);
      break;

    case "tts":
      if (!eSpeakDataPath) {
        throw new ESpeakDataPathRequiredError();
      }
      result = createTtsModel(
        modelId,
        modelPath,
        modelConfig,
        ttsConfigModelPath!,
        eSpeakDataPath,
      );
      break;

    default:
      // Should never happen
      throw new UnknownModelTypeError(modelType);
  }

  logger.info(`${modelType}: Loading model ${modelId}...`);

  startLogBuffering(modelId);

  await result.model.load(false);
  logger.info(`${modelType} model ${modelId} loaded`);

  stopLogBufferingWithTimeout(modelId);

  registerModel(modelId, {
    model: result.model,
    path: modelPath,
    config: modelConfig,
    modelType,
    name: modelName,
    loader: result.loader,
  });
}
