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
import { TtsReferenceAudioRequiredError } from "@/utils/errors-server";
import { textToSpeech } from "@/server/bare/plugins/onnx-tts/ops/text-to-speech";
import { loadReferenceAudioAt24k } from "@/server/bare/plugins/onnx-tts/wav-helper";

function createTtsModel(
  modelId: string,
  ttsConfig: TtsConfig,
  tokenizerPath: string,
  speechEncoderPath: string,
  embedTokensPath: string,
  conditionalDecoderPath: string,
  languageModelPath: string,
  referenceAudio: Float32Array,
): PluginModelResult {
  const logger = createStreamLogger(modelId, "tts");

  const args = {
    tokenizerPath,
    speechEncoderPath,
    embedTokensPath,
    conditionalDecoderPath,
    languageModelPath,
    referenceAudio,
    logger,
    opts: { stats: true },
  };

  const config = {
    language: ttsConfig.language,
    useGPU: false,
  };

  // Chatterbox-only args; @qvac/tts-onnx types may still declare legacy Piper fields until package is republished
  const model = new ONNXTTS(args as never, config);

  return { model, loader: undefined };
}

export const ttsPlugin = definePlugin({
  modelType: ModelType.onnxTts,
  displayName: "TTS (ONNX)",
  addonPackage: "@qvac/tts-onnx",

  createModel(params: CreateModelParams): PluginModelResult {
    const ttsConfig = (params.modelConfig ?? {}) as TtsConfig;
    const artifacts = params.artifacts ?? {};
    const tokenizerPath = artifacts["tokenizerPath"] ?? "";
    const speechEncoderPath = artifacts["speechEncoderPath"] ?? "";
    const embedTokensPath = artifacts["embedTokensPath"] ?? "";
    const conditionalDecoderPath = artifacts["conditionalDecoderPath"] ?? "";
    const languageModelPath = artifacts["languageModelPath"] ?? "";
    const referenceAudioPath = artifacts["referenceAudioPath"] ?? "";
    if (!referenceAudioPath) {
      throw new TtsReferenceAudioRequiredError();
    }
    const referenceAudio = loadReferenceAudioAt24k(referenceAudioPath);

    return createTtsModel(
      params.modelId,
      ttsConfig,
      tokenizerPath,
      speechEncoderPath,
      embedTokensPath,
      conditionalDecoderPath,
      languageModelPath,
      referenceAudio,
    );
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
