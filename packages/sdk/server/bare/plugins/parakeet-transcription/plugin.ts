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
  parakeetConfigSchema,
  ADDON_PARAKEET,
  type ModelSrcInput,
  type ParakeetRuntimeConfig,
  type CreateModelParams,
  type PluginModelResult,
  type ResolveContext,
  type ResolveResult,
} from "@/schemas";
import { ADDON_NAMESPACES, createStreamLogger } from "@/logging";
import { parseModelPath } from "@/server/utils";
import { ModelLoadFailedError } from "@/utils/errors-server";
import FilesystemDL from "@qvac/dl-filesystem";
import { transcribe } from "@/server/bare/ops/transcribe";

function createParakeetModel(
  modelId: string,
  encoderPath: string,
  config: ParakeetRuntimeConfig,
  decoderPath: string,
  vocabPath: string,
  preprocessorPath: string,
  encoderDataPath?: string,
) {
  const { dirPath } = parseModelPath(encoderPath);

  const loader = new FilesystemDL({ dirPath });
  const logger = createStreamLogger(modelId, "parakeet");

  const args: TranscriptionParakeetArgs = {
    loader,
    logger,
    modelName: parseModelPath(dirPath).basePath,
    diskPath: dirPath,
  };

  const filePaths: Record<string, string> = {
    "encoder-model.onnx": encoderPath,
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
    encoderPath,
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
  addonPackage: ADDON_PARAKEET,
  loadConfigSchema: parakeetConfigSchema,
  skipPrimaryModelPathValidation: true,

  async resolveConfig(
    cfg: Record<string, unknown>,
    ctx: ResolveContext,
  ): Promise<ResolveResult<Record<string, unknown>>> {
    const resolve = ctx.resolveModelPath;
    const {
      parakeetEncoderSrc,
      parakeetEncoderDataSrc,
      parakeetDecoderSrc,
      parakeetVocabSrc,
      parakeetPreprocessorSrc,
      ...parakeetConfig
    } = cfg as Record<string, unknown> & {
      parakeetEncoderSrc: ModelSrcInput;
      parakeetEncoderDataSrc?: ModelSrcInput;
      parakeetDecoderSrc: ModelSrcInput;
      parakeetVocabSrc: ModelSrcInput;
      parakeetPreprocessorSrc: ModelSrcInput;
    };

    const [encoderPath, encoderDataPath, decoderPath, vocabPath, preprocessorPath] =
      await Promise.all([
        resolve(parakeetEncoderSrc),
        parakeetEncoderDataSrc ? resolve(parakeetEncoderDataSrc) : undefined,
        resolve(parakeetDecoderSrc),
        resolve(parakeetVocabSrc),
        resolve(parakeetPreprocessorSrc),
      ]);

    return {
      config: parakeetConfig as ParakeetRuntimeConfig,
      artifacts: {
        encoderPath,
        ...(encoderDataPath !== undefined && { encoderDataPath }),
        ...(decoderPath !== undefined && { decoderPath }),
        ...(vocabPath !== undefined && { vocabPath }),
        ...(preprocessorPath !== undefined && { preprocessorPath }),
      },
    };
  },

  createModel(params: CreateModelParams): PluginModelResult {
    const config = (params.modelConfig ?? {}) as ParakeetRuntimeConfig;
    const artifacts = params.artifacts ?? {};

    const encoderPath = artifacts["encoderPath"];
    const decoderPath = artifacts["decoderPath"];
    const vocabPath = artifacts["vocabPath"];
    const preprocessorPath = artifacts["preprocessorPath"];

    if (!encoderPath || !decoderPath || !vocabPath || !preprocessorPath) {
      throw new ModelLoadFailedError(
        "Parakeet requires model file paths: parakeetEncoderSrc, parakeetDecoderSrc, parakeetVocabSrc, parakeetPreprocessorSrc in modelConfig",
      );
    }

    return createParakeetModel(
      params.modelId,
      encoderPath,
      config,
      decoderPath,
      vocabPath,
      preprocessorPath,
      artifacts["encoderDataPath"],
    );
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
