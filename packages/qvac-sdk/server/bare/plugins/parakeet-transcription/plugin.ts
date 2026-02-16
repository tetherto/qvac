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
) {
  const { dirPath } = parseModelPath(modelPath);

  const loader = new FilesystemDL({ dirPath });
  const logger = createStreamLogger(modelId, "parakeet");

  // modelName uses the directory name (not file name) because parakeet is a
  // multi-file model — the addon resolves individual files relative to dirPath.
  const args = {
    loader,
    logger,
    modelName: parseModelPath(dirPath).basePath,
    diskPath: dirPath,
  } as unknown as TranscriptionParakeetArgs;

  const config: UpstreamConfig = {
    path: dirPath,
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
