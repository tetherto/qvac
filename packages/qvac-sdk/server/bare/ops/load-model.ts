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
  ModelLoadFailedError,
  PluginNotFoundError,
  ModelFileNotFoundError,
  ModelFileNotFoundInDirError,
  ModelFileLocateFailedError,
  TtsArtifactsRequiredError,
  TtsReferenceAudioRequiredError,
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
    ttsTokenizerPath,
    ttsSpeechEncoderPath,
    ttsEmbedTokensPath,
    ttsConditionalDecoderPath,
    ttsLanguageModelPath,
    referenceAudioPath,
    ttsVoicePath,
    ttsSpeed,
    ttsNumInferenceSteps,
    ttsTextEncoderPath,
    ttsLatentDenoiserPath,
    ttsVoiceDecoderPath,
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
  } else if (modelType !== ModelType.onnxTts) {
    // For non-sharded, non-TTS models, validate single file exists
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
  // TTS: Chatterbox (5 artifacts + reference) or Supertonic (5 explicit artifact paths)
  const isTtsSupertonic =
    modelType === ModelType.onnxTts &&
    ttsTextEncoderPath != null;

  if (modelType === ModelType.onnxTts) {
    if (isTtsSupertonic) {
      if (
        !ttsTokenizerPath ||
        !ttsTextEncoderPath ||
        !ttsLatentDenoiserPath ||
        !ttsVoiceDecoderPath ||
        !ttsVoicePath
      ) {
        throw new TtsArtifactsRequiredError();
      }
    } else {
      const hasAllChatterboxArtifacts =
        ttsTokenizerPath &&
        ttsSpeechEncoderPath &&
        ttsEmbedTokensPath &&
        ttsConditionalDecoderPath &&
        ttsLanguageModelPath;
      if (!hasAllChatterboxArtifacts) {
        throw new TtsArtifactsRequiredError();
      }
      if (!referenceAudioPath) {
        throw new TtsReferenceAudioRequiredError();
      }
    }
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
  if (ttsTokenizerPath) artifacts["tokenizerPath"] = ttsTokenizerPath;
  if (ttsSpeechEncoderPath)
    artifacts["speechEncoderPath"] = ttsSpeechEncoderPath;
  if (ttsEmbedTokensPath) artifacts["embedTokensPath"] = ttsEmbedTokensPath;
  if (ttsConditionalDecoderPath)
    artifacts["conditionalDecoderPath"] = ttsConditionalDecoderPath;
  if (ttsLanguageModelPath)
    artifacts["languageModelPath"] = ttsLanguageModelPath;
  if (referenceAudioPath) artifacts["referenceAudioPath"] = referenceAudioPath;
  if (ttsVoicePath) artifacts["voicePath"] = ttsVoicePath;
  if (ttsSpeed != null) artifacts["speed"] = String(ttsSpeed);
  if (ttsNumInferenceSteps != null)
    artifacts["numInferenceSteps"] = String(ttsNumInferenceSteps);
  if (ttsTextEncoderPath) artifacts["textEncoderPath"] = ttsTextEncoderPath;
  if (ttsLatentDenoiserPath)
    artifacts["latentDenoiserPath"] = ttsLatentDenoiserPath;
  if (ttsVoiceDecoderPath)
    artifacts["voiceDecoderPath"] = ttsVoiceDecoderPath;
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
