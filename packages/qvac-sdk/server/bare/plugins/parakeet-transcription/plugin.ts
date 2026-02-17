import parakeetAddonLogging from "@qvac/transcription-parakeet/addonLogging";
import TranscriptionParakeet, {
  type ParakeetConfig as TranscriptionParakeetConfig,
  type TranscriptionParakeetArgs,
  type TranscriptionParakeetConfig as UpstreamConfig,
} from "@qvac/transcription-parakeet";
import {
  definePlugin,
  ModelType,
  type CreateModelParams,
  type PluginModelResult,
  type ParakeetConfig,
} from "@/schemas";
import { ADDON_NAMESPACES, createStreamLogger } from "@/logging";
import { parseModelPath } from "@/server/utils";
import FilesystemDL from "@qvac/dl-filesystem";
import { transcribe } from "@/server/bare/plugins/parakeet-transcription/ops/transcribe-stream";
import { createTranscribeStreamHandler } from "@/server/bare/utils/transcription-handler";

function createParakeetModel(
  modelId: string,
  modelPath: string,
  parakeetConfig: ParakeetConfig,
  artifacts?: Record<string, string>,
) {
  const { dirPath } = parseModelPath(modelPath);

  const loader = new FilesystemDL({ dirPath });
  const logger = createStreamLogger(modelId, "parakeet");

  const args = {
    loader,
    logger,
    modelName: parseModelPath(dirPath).basePath,
    diskPath: dirPath,
  } as unknown as TranscriptionParakeetArgs;

  // Build filePaths map from individually-resolved artifact paths
  const filePaths: Record<string, string> | undefined =
    artifacts &&
    (artifacts["parakeetEncoderDataPath"] ||
      artifacts["parakeetDecoderPath"] ||
      artifacts["parakeetVocabPath"] ||
      artifacts["parakeetPreprocessorPath"])
      ? {
          "encoder-model.onnx": modelPath,
          ...(artifacts["parakeetEncoderDataPath"] && {
            "encoder-model.onnx.data": artifacts["parakeetEncoderDataPath"],
          }),
          ...(artifacts["parakeetDecoderPath"] && {
            "decoder_joint-model.onnx": artifacts["parakeetDecoderPath"],
          }),
          ...(artifacts["parakeetVocabPath"] && {
            "vocab.txt": artifacts["parakeetVocabPath"],
          }),
          ...(artifacts["parakeetPreprocessorPath"] && {
            "preprocessor.onnx": artifacts["parakeetPreprocessorPath"],
          }),
        }
      : undefined;

  const config: UpstreamConfig = {
    path: dirPath,
    ...(filePaths && { filePaths }),
    parakeetConfig: parakeetConfig as TranscriptionParakeetConfig,
  };

  const model = new TranscriptionParakeet(args, config);

  return { model, loader };
}

export const parakeetPlugin = definePlugin({
  modelType: ModelType.parakeetTranscription,
  displayName: "Parakeet (NVIDIA NeMo ONNX)",
  addonPackage: "@qvac/transcription-parakeet",

  createModel(params: CreateModelParams): PluginModelResult {
    const parakeetConfig = (params.modelConfig ?? {}) as ParakeetConfig;

    const { model, loader } = createParakeetModel(
      params.modelId,
      params.modelPath,
      parakeetConfig,
      params.artifacts,
    );

    return { model, loader };
  },

  handlers: {
    transcribeStream: createTranscribeStreamHandler(transcribe),
  },

  logging: {
    module: parakeetAddonLogging,
    namespace: ADDON_NAMESPACES.PARAKEET,
  },
});
