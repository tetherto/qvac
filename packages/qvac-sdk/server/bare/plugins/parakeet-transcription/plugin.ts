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

function createParakeetModel(
  modelId: string,
  modelPath: string,
  parakeetConfig: ParakeetConfig,
  artifacts: Record<string, string>,
) {
  const { dirPath } = parseModelPath(modelPath);

  const encoderDataPath = artifacts["parakeetEncoderDataPath"];
  const decoderPath = artifacts["parakeetDecoderPath"];
  const vocabPath = artifacts["parakeetVocabPath"];
  const preprocessorPath = artifacts["parakeetPreprocessorPath"];

  if (!encoderDataPath || !decoderPath || !vocabPath || !preprocessorPath) {
    throw new ModelLoadFailedError(
      "Parakeet requires all artifact paths: parakeetEncoderDataSrc, parakeetDecoderSrc, parakeetVocabSrc, parakeetPreprocessorSrc",
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

  const config: TranscriptionParakeetConfig = {
    path: dirPath,
    filePaths: {
      "encoder-model.onnx": modelPath,
      "encoder-model.onnx.data": encoderDataPath,
      "decoder_joint-model.onnx": decoderPath,
      "vocab.txt": vocabPath,
      "preprocessor.onnx": preprocessorPath,
    },
    parakeetConfig: parakeetConfig as ParakeetConfig,
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
    const artifacts = params.artifacts ?? {};

    return createParakeetModel(
      params.modelId,
      params.modelPath,
      parakeetConfig,
      artifacts,
    );
  },

  handlers: {
    transcribeStream: createTranscribeStreamHandler(transcribe),
  },

  logging: {
    module: parakeetAddonLogging,
    namespace: ADDON_NAMESPACES.PARAKEET,
  },
});
