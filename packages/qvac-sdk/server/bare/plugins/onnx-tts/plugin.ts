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
  type TtsConfig,
} from "@/schemas";
import { ADDON_NAMESPACES, createStreamLogger } from "@/logging";
import { TtsArtifactsRequiredError } from "@/utils/errors-server";
import { textToSpeech } from "@/server/bare/plugins/onnx-tts/ops/text-to-speech";
import { loadReferenceAudioAt24k } from "@/server/bare/plugins/onnx-tts/wav-helper";

function createChatterboxModel(
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
  const config = { language: ttsConfig.language, useGPU: false };
  const model = new ONNXTTS(args as never, config);
  return { model, loader: undefined };
}

function createSupertonicModel(
  modelId: string,
  ttsConfig: TtsConfig,
  artifacts: Record<string, string>,
): PluginModelResult {
  const logger = createStreamLogger(modelId, "tts");
  const voicePath = artifacts["voicePath"];
  if (!voicePath) {
    throw new TtsArtifactsRequiredError();
  }
  const voicesDir = path.dirname(voicePath);
  const voiceName = path.basename(voicePath).replace(/\.bin$/i, "") || "voice";
  const speed = artifacts["speed"] != null ? Number(artifacts["speed"]) : 1;
  const numInferenceSteps =
    artifacts["numInferenceSteps"] != null
      ? Number(artifacts["numInferenceSteps"])
      : 5;
  const args = {
    tokenizerPath: artifacts["tokenizerPath"],
    textEncoderPath: artifacts["textEncoderPath"],
    latentDenoiserPath: artifacts["latentDenoiserPath"],
    voiceDecoderPath: artifacts["voiceDecoderPath"],
    voicesDir,
    voiceName,
    speed,
    numInferenceSteps,
    logger,
    opts: { stats: true },
  };
  const config = { language: ttsConfig.language };
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
    const referenceAudioPath = artifacts["referenceAudioPath"] ?? "";
    const textEncoderPath = artifacts["textEncoderPath"] ?? "";

    if (referenceAudioPath) {
      const tokenizerPath = artifacts["tokenizerPath"] ?? "";
      const speechEncoderPath = artifacts["speechEncoderPath"] ?? "";
      const embedTokensPath = artifacts["embedTokensPath"] ?? "";
      const conditionalDecoderPath = artifacts["conditionalDecoderPath"] ?? "";
      const languageModelPath = artifacts["languageModelPath"] ?? "";
      const referenceAudio = loadReferenceAudioAt24k(referenceAudioPath);
      return createChatterboxModel(
        params.modelId,
        ttsConfig,
        tokenizerPath,
        speechEncoderPath,
        embedTokensPath,
        conditionalDecoderPath,
        languageModelPath,
        referenceAudio,
      );
    }

    if (textEncoderPath) {
      return createSupertonicModel(params.modelId, ttsConfig, artifacts);
    }

    throw new TtsArtifactsRequiredError();
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
