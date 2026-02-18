import ttsAddonLogging from "@qvac/tts-onnx/addonLogging";
import ONNXTTS from "@qvac/tts-onnx";
import {
  definePlugin,
  defineHandler,
  ttsRequestSchema,
  ttsResponseSchema,
  ModelType,
  type CreateModelParams,
  type PluginModelResult,
  type TtsConfig,
} from "@/schemas";
import { ADDON_NAMESPACES, createStreamLogger } from "@/logging";
import { parseModelPath } from "@/server/utils";
import FilesystemDL from "@qvac/dl-filesystem";
import { textToSpeech } from "@/server/bare/plugins/onnx-tts/ops/text-to-speech";

function createTtsModel(
  modelId: string,
  modelPath: string,
  ttsConfig: TtsConfig,
  ttsConfigModelPath: string,
  eSpeakDataPath: string,
) {
  const { dirPath, basePath: fileName } = parseModelPath(modelPath);
  const loader = new FilesystemDL({ dirPath });
  const logger = createStreamLogger(modelId, "tts");

  const args = {
    loader,
    logger,
    mainModelUrl: fileName,
    configJsonPath: parseModelPath(ttsConfigModelPath).basePath,
    cache: dirPath,
    eSpeakDataPath: eSpeakDataPath,
    opts: { stats: true },
  };

  const config = {
    language: ttsConfig.language,
  };

  const model = new ONNXTTS(args, config);

  return { model, loader };
}

export const ttsPlugin = definePlugin({
  modelType: ModelType.onnxTts,
  displayName: "TTS (ONNX)",
  addonPackage: "@qvac/tts-onnx",

  createModel(params: CreateModelParams): PluginModelResult {
    const ttsConfig = (params.modelConfig ?? {}) as TtsConfig;

    const { model, loader } = createTtsModel(
      params.modelId,
      params.modelPath,
      ttsConfig,
      params.artifacts?.["ttsConfigModelPath"] ?? "",
      params.artifacts?.["eSpeakDataPath"] ?? "",
    );

    return { model, loader };
  },

  handlers: {
    textToSpeech: defineHandler({
      requestSchema: ttsRequestSchema,
      responseSchema: ttsResponseSchema,
      streaming: true,

      handler: async function* (request) {
        for await (const response of textToSpeech(request)) {
          yield response;
        }
      },
    }),
  },

  logging: {
    module: ttsAddonLogging,
    namespace: ADDON_NAMESPACES.TTS,
  },
});
