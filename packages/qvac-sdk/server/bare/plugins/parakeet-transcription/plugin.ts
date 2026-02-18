import parakeetAddonLogging from "@qvac/transcription-parakeet/addonLogging";
import TranscriptionParakeet, {
  type ParakeetConfig,
  type TranscriptionParakeetArgs,
  type TranscriptionParakeetConfig,
} from "@qvac/transcription-parakeet";
import {
  definePlugin,
  ModelType,
  type CreateModelParams,
  type PluginModelResult,
} from "@/schemas";
import { ADDON_NAMESPACES, createStreamLogger } from "@/logging";
import { parseModelPath } from "@/server/utils";
import { ModelLoadFailedError } from "@/utils/errors-server";
import FilesystemDL from "@qvac/dl-filesystem";
import { transcribe } from "@/server/bare/plugins/parakeet-transcription/ops/transcribe-stream";
import { createTranscribeStreamHandler } from "@/server/bare/utils/transcription-handler";

type ParakeetModelConfig = {
  modelType?: string;
  encoderDataPath?: string;
  decoderPath?: string;
  vocabPath?: string;
  preprocessorPath?: string;
  maxThreads?: number;
  useGPU?: boolean;
  sampleRate?: number;
  channels?: number;
  captionEnabled?: boolean;
  timestampsEnabled?: boolean;
  seed?: number;
};

function createParakeetModel(
  modelId: string,
  modelPath: string,
  config: ParakeetModelConfig,
) {
  const { dirPath } = parseModelPath(modelPath);

  const { encoderDataPath, decoderPath, vocabPath, preprocessorPath } = config;

  if (!encoderDataPath || !decoderPath || !vocabPath || !preprocessorPath) {
    throw new ModelLoadFailedError(
      "Parakeet requires all model file paths: parakeetEncoderDataSrc, parakeetDecoderSrc, parakeetVocabSrc, parakeetPreprocessorSrc in modelConfig",
    );
  }

  const loader = new FilesystemDL({ dirPath });
  const logger = createStreamLogger(modelId, "parakeet");

  const args = {
    loader,
    logger,
    modelName: parseModelPath(dirPath).basePath,
    diskPath: dirPath,
  } as unknown as TranscriptionParakeetArgs;

  const addonConfig: TranscriptionParakeetConfig = {
    path: dirPath,
    filePaths: {
      "encoder-model.onnx": modelPath,
      "encoder-model.onnx.data": encoderDataPath,
      "decoder_joint-model.onnx": decoderPath,
      "vocab.txt": vocabPath,
      "preprocessor.onnx": preprocessorPath,
    },
    parakeetConfig: {
      modelType: config.modelType ?? "tdt",
    } as ParakeetConfig,
  };

  const model = new TranscriptionParakeet(args, addonConfig);

  return { model, loader };
}

export const parakeetPlugin = definePlugin({
  modelType: ModelType.parakeetTranscription,
  displayName: "Parakeet (NVIDIA NeMo ONNX)",
  addonPackage: "@qvac/transcription-parakeet",

  createModel(params: CreateModelParams): PluginModelResult {
    const config = (params.modelConfig ?? {}) as ParakeetModelConfig;

    return createParakeetModel(params.modelId, params.modelPath, config);
  },

  handlers: {
    transcribeStream: createTranscribeStreamHandler(transcribe),
  },

  logging: {
    module: parakeetAddonLogging,
    namespace: ADDON_NAMESPACES.PARAKEET,
  },
});
