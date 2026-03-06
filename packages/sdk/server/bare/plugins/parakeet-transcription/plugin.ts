import parakeetAddonLogging from "@qvac/transcription-parakeet/addonLogging";
import TranscriptionParakeet, {
  type ParakeetConfig,
  type TranscriptionParakeetArgs,
  type TranscriptionParakeetConfig,
} from "@qvac/transcription-parakeet";
import {
  definePlugin,
  defineHandler,
  transcribeStreamRequestSchema,
  transcribeStreamResponseSchema,
  ModelType,
  type ParakeetRuntimeConfig,
  type CreateModelParams,
  type PluginModelResult,
  type ResolveModelPath,
} from "@/schemas";
import { ADDON_NAMESPACES, createStreamLogger } from "@/logging";
import { parseModelPath } from "@/server/utils";
import { ModelLoadFailedError } from "@/utils/errors-server";
import FilesystemDL from "@qvac/dl-filesystem";
import { transcribe } from "@/server/bare/ops/transcribe";

type ParakeetModelConfig = ParakeetRuntimeConfig & {
  encoderDataPath?: string;
  decoderPath?: string;
  vocabPath?: string;
  preprocessorPath?: string;
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

  const args: TranscriptionParakeetArgs = {
    loader,
    logger,
    modelName: parseModelPath(dirPath).basePath,
    diskPath: dirPath,
  };

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
      maxThreads: config.maxThreads,
      useGPU: config.useGPU,
      sampleRate: config.sampleRate,
      channels: config.channels,
      captionEnabled: config.captionEnabled,
      timestampsEnabled: config.timestampsEnabled,
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

    const [encoderDataPath, decoderPath, vocabPath, preprocessorPath] = await Promise.all([
      config.parakeetEncoderDataSrc ? resolve(config.parakeetEncoderDataSrc) : undefined,
      config.parakeetDecoderSrc ? resolve(config.parakeetDecoderSrc) : undefined,
      config.parakeetVocabSrc ? resolve(config.parakeetVocabSrc) : undefined,
      config.parakeetPreprocessorSrc ? resolve(config.parakeetPreprocessorSrc) : undefined,
    ]);

    return { ...modelConfig, encoderDataPath, decoderPath, vocabPath, preprocessorPath };
  },

  createModel(params: CreateModelParams): PluginModelResult {
    const config = (params.modelConfig ?? {}) as ParakeetModelConfig;

    return createParakeetModel(params.modelId, params.modelPath, config);
  },

  handlers: {
    transcribeStream: defineHandler({
      requestSchema: transcribeStreamRequestSchema,
      responseSchema: transcribeStreamResponseSchema,
      streaming: true,

      handler: async function* (request) {
        for await (const text of transcribe({
          modelId: request.modelId,
          audioChunk: request.audioChunk,
          prompt: request.prompt,
        })) {
          yield {
            type: "transcribeStream" as const,
            text,
          };
        }

        yield {
          type: "transcribeStream" as const,
          text: "",
          done: true,
        };
      },
    }),
  },

  logging: {
    module: parakeetAddonLogging,
    namespace: ADDON_NAMESPACES.PARAKEET,
  },
});
