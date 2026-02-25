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
  type ResolveModelPath,
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

  if (!decoderPath || !vocabPath || !preprocessorPath) {
    throw new ModelLoadFailedError(
      "Parakeet requires model file paths: parakeetDecoderSrc, parakeetVocabSrc, parakeetPreprocessorSrc in modelConfig",
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

  const filePaths: Record<string, string> = {
    "encoder-model.onnx": modelPath,
    "decoder_joint-model.onnx": decoderPath,
    "vocab.txt": vocabPath,
    "preprocessor.onnx": preprocessorPath,
  };
  if (encoderDataPath) {
    filePaths["encoder-model.onnx.data"] = encoderDataPath;
  }

  const addonConfig: TranscriptionParakeetConfig = {
    path: dirPath,
    filePaths,
    encoderPath: modelPath,
    ...(encoderDataPath ? { encoderDataPath } : {}),
    decoderPath,
    vocabPath,
    preprocessorPath,
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

  async resolveConfig(
    modelConfig: Record<string, unknown>,
    resolve: ResolveModelPath,
  ): Promise<Record<string, unknown>> {
    const config = modelConfig as {
      parakeetEncoderDataSrc?: string;
      parakeetDecoderSrc?: string;
      parakeetVocabSrc?: string;
      parakeetPreprocessorSrc?: string;
    };

    // Resolve sequentially to avoid race conditions with registry client
    const encoderDataPath = config.parakeetEncoderDataSrc
      ? await resolve(config.parakeetEncoderDataSrc)
      : undefined;
    const decoderPath = config.parakeetDecoderSrc
      ? await resolve(config.parakeetDecoderSrc)
      : undefined;
    const vocabPath = config.parakeetVocabSrc
      ? await resolve(config.parakeetVocabSrc)
      : undefined;
    const preprocessorPath = config.parakeetPreprocessorSrc
      ? await resolve(config.parakeetPreprocessorSrc)
      : undefined;

    return { ...modelConfig, encoderDataPath, decoderPath, vocabPath, preprocessorPath };
  },

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
