import path from "bare-path";
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
} from "@/schemas";
import { ADDON_NAMESPACES, createStreamLogger } from "@/logging";
import {
  TtsArtifactsRequiredError,
  TtsReferenceAudioRequiredError,
} from "@/utils/errors-server";
import { textToSpeech } from "@/server/bare/plugins/onnx-tts/ops/text-to-speech";
import { loadReferenceAudioAt24k } from "@/server/bare/plugins/onnx-tts/wav-helper";

type TtsModelConfig = {
  ttsEngine?: "chatterbox" | "supertonic";
  language?: string;
  tokenizerPath?: string;
  speechEncoderPath?: string;
  embedTokensPath?: string;
  conditionalDecoderPath?: string;
  languageModelPath?: string;
  referenceAudioPath?: string;
  textEncoderPath?: string;
  latentDenoiserPath?: string;
  voiceDecoderPath?: string;
  voicePath?: string;
  speed?: number;
  numInferenceSteps?: number;
};

function createChatterboxModel(
  modelId: string,
  config: TtsModelConfig,
): PluginModelResult {
  const {
    tokenizerPath,
    speechEncoderPath,
    embedTokensPath,
    conditionalDecoderPath,
    languageModelPath,
    referenceAudioPath,
    language,
  } = config;

  if (
    !tokenizerPath ||
    !speechEncoderPath ||
    !embedTokensPath ||
    !conditionalDecoderPath ||
    !languageModelPath
  ) {
    throw new TtsArtifactsRequiredError();
  }
  if (!referenceAudioPath) {
    throw new TtsReferenceAudioRequiredError();
  }

  const logger = createStreamLogger(modelId, "tts");
  const referenceAudio = loadReferenceAudioAt24k(referenceAudioPath);
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
  const modelConfig = { language: language ?? "en", useGPU: false };
  const model = new ONNXTTS(args as never, modelConfig);
  return { model, loader: undefined };
}

function createSupertonicModel(
  modelId: string,
  config: TtsModelConfig,
): PluginModelResult {
  const {
    tokenizerPath,
    textEncoderPath,
    latentDenoiserPath,
    voiceDecoderPath,
    voicePath,
    speed,
    numInferenceSteps,
    language,
  } = config;

  if (
    !tokenizerPath ||
    !textEncoderPath ||
    !latentDenoiserPath ||
    !voiceDecoderPath ||
    !voicePath
  ) {
    throw new TtsArtifactsRequiredError();
  }

  const logger = createStreamLogger(modelId, "tts");
  const voicesDir = path.dirname(voicePath);
  const voiceName = path.basename(voicePath).replace(/\.bin$/i, "") || "voice";
  const args = {
    tokenizerPath,
    textEncoderPath,
    latentDenoiserPath,
    voiceDecoderPath,
    voicesDir,
    voiceName,
    speed: speed ?? 1,
    numInferenceSteps: numInferenceSteps ?? 5,
    logger,
    opts: { stats: true },
  };
  const modelConfig = { language: language ?? "en" };
  const model = new ONNXTTS(args as never, modelConfig);
  return { model, loader: undefined };
}

export const ttsPlugin = definePlugin({
  modelType: ModelType.onnxTts,
  displayName: "TTS (ONNX)",
  addonPackage: "@qvac/tts-onnx",

  createModel(params: CreateModelParams): PluginModelResult {
    const config = (params.modelConfig ?? {}) as TtsModelConfig;

    if (config.ttsEngine === "supertonic") {
      return createSupertonicModel(params.modelId, config);
    }

    // Default to Chatterbox if engine not specified or is "chatterbox"
    return createChatterboxModel(params.modelId, config);
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
