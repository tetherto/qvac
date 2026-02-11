import {
  loadModelServerParamsSchema,
  ModelType,
  type EmbedConfig,
  type LlmConfig,
  type LoadModelServerParams,
  type WhisperConfig,
} from "@/schemas";
import { createLlmModel } from "@/server/bare/addons/llamacpp-completion";
import { createEmbeddingsModel } from "@/server/bare/addons/llamacpp-embedding";
import { createNmtModel } from "@/server/bare/addons/nmtcpp-translation";
import { createTtsModel } from "@/server/bare/addons/onnx-tts";
import { createWhisperModel } from "@/server/bare/addons/whispercpp-transcription";
import { createOCRModel } from "@/server/bare/addons/onnx-ocr";
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
    chatterboxPaths,
    chatterboxReferenceAudioSamples,
    detectorModelPath,
    modelName,
  } = loadModelServerParamsSchema.parse(params);
  const { modelConfig, modelType } = options;

  // Check if model is already loaded
  if (isModelLoaded(modelId)) {
    logger.info(`${modelType} model ${modelId} is already loaded`);
    return;
  }

  // Detect if sharded model (skip for Chatterbox TTS: we validate five paths below)
  const modelFileName = path.basename(modelPath);
  const shardInfo = detectShardedModel(modelFileName);
  const isShardedModel = shardInfo.isSharded;

  if (chatterboxPaths) {
    try {
      const paths = [
        chatterboxPaths.tokenizerPath,
        chatterboxPaths.speechEncoderPath,
        chatterboxPaths.embedTokensPath,
        chatterboxPaths.conditionalDecoderPath,
        chatterboxPaths.languageModelPath,
      ];
      for (const filePath of paths) {
        await fsPromises.access(filePath);
      }
    } catch (error) {
      logger.error(
        `Chatterbox TTS: one or more model files not found:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new ModelFileLocateFailedError(modelType, modelPath, error);
    }
  } else if (isShardedModel) {
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

  let result: { model: AnyModel; loader: FilesystemDL };
  switch (modelType) {
    case ModelType.llamacppCompletion:
      result = createLlmModel(
        modelId,
        modelPath,
        modelConfig as LlmConfig,
        projectionModelPath,
      );
      break;
    case ModelType.whispercppTranscription:
      result = createWhisperModel(
        modelId,
        modelPath,
        modelConfig as WhisperConfig,
        vadModelPath,
      );
      break;
    case ModelType.llamacppEmbedding:
      result = createEmbeddingsModel(
        modelId,
        modelPath,
        modelConfig as EmbedConfig,
      );
      break;

    case ModelType.nmtcppTranslation:
      result = createNmtModel(modelId, modelPath, modelConfig);
      break;

    case ModelType.onnxTts:
      if (chatterboxPaths) {
        result = createTtsModel(modelId, modelPath, modelConfig, {
          chatterboxPaths,
          ...(chatterboxReferenceAudioSamples?.length
            ? { referenceAudioSamples: chatterboxReferenceAudioSamples }
            : {}),
        });
      } else {
        if (!eSpeakDataPath) {
          throw new ESpeakDataPathRequiredError();
        }
        result = createTtsModel(modelId, modelPath, modelConfig, {
          ttsConfigModelPath: ttsConfigModelPath!,
          eSpeakDataPath,
        });
      }
      break;

    case ModelType.onnxOcr:
      if (!detectorModelPath) {
        throw new ModelLoadFailedError(
          "Detector model required for OCR. Use a hyperdrive source or provide detectorModelSrc",
        );
      }
      // modelPath is the recognizer, detectorModelPath is auto-derived
      result = createOCRModel(
        modelId,
        detectorModelPath,
        modelPath,
        modelConfig,
      );
      break;

    default:
      // Should never happen - normalizeModelType validates input
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
