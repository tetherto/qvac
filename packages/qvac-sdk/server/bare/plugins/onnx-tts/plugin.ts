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
  type ResolveModelPath,
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
  // Chatterbox fields
  ttsTokenizerSrc?: string;
  ttsSpeechEncoderSrc?: string;
  ttsEmbedTokensSrc?: string;
  ttsConditionalDecoderSrc?: string;
  ttsLanguageModelSrc?: string;
  referenceAudioSrc?: string;
  // Supertonic fields
  ttsTextEncoderSrc?: string;
  ttsLatentDenoiserSrc?: string;
  ttsVoiceDecoderSrc?: string;
  ttsVoiceSrc?: string;
  ttsSpeed?: number;
  ttsNumInferenceSteps?: number;
};

async function resolveChatterboxConfig(
  config: TtsModelConfig,
  resolve: ResolveModelPath,
): Promise<TtsModelConfig> {
  const {
    ttsTokenizerSrc,
    ttsSpeechEncoderSrc,
    ttsEmbedTokensSrc,
    ttsConditionalDecoderSrc,
    ttsLanguageModelSrc,
    referenceAudioSrc,
    language,
  } = config;

  if (
    !ttsTokenizerSrc ||
    !ttsSpeechEncoderSrc ||
    !ttsEmbedTokensSrc ||
    !ttsConditionalDecoderSrc ||
    !ttsLanguageModelSrc
  ) {
    throw new TtsArtifactsRequiredError();
  }
  if (!referenceAudioSrc) {
    throw new TtsReferenceAudioRequiredError();
  }

  // Download sequentially to avoid race conditions with registry client
  const resolvedTokenizer = await resolve(ttsTokenizerSrc);
  const resolvedSpeechEncoder = await resolve(ttsSpeechEncoderSrc);
  const resolvedEmbedTokens = await resolve(ttsEmbedTokensSrc);
  const resolvedConditionalDecoder = await resolve(ttsConditionalDecoderSrc);
  const resolvedLanguageModel = await resolve(ttsLanguageModelSrc);
  const resolvedReferenceAudio = await resolve(referenceAudioSrc);

  const result: TtsModelConfig = {
    ttsEngine: "chatterbox",
    ttsTokenizerSrc: resolvedTokenizer,
    ttsSpeechEncoderSrc: resolvedSpeechEncoder,
    ttsEmbedTokensSrc: resolvedEmbedTokens,
    ttsConditionalDecoderSrc: resolvedConditionalDecoder,
    ttsLanguageModelSrc: resolvedLanguageModel,
    referenceAudioSrc: resolvedReferenceAudio,
  };
  if (language) result.language = language;
  return result;
}

async function resolveSupertonicConfig(
  config: TtsModelConfig,
  resolve: ResolveModelPath,
): Promise<TtsModelConfig> {
  const {
    ttsTokenizerSrc,
    ttsTextEncoderSrc,
    ttsLatentDenoiserSrc,
    ttsVoiceDecoderSrc,
    ttsVoiceSrc,
    ttsSpeed,
    ttsNumInferenceSteps,
    language,
  } = config;

  if (
    !ttsTokenizerSrc ||
    !ttsTextEncoderSrc ||
    !ttsLatentDenoiserSrc ||
    !ttsVoiceDecoderSrc ||
    !ttsVoiceSrc
  ) {
    throw new TtsArtifactsRequiredError();
  }

  // Download sequentially to avoid race conditions with registry client
  const resolvedTokenizer = await resolve(ttsTokenizerSrc);
  const resolvedTextEncoder = await resolve(ttsTextEncoderSrc);
  const resolvedLatentDenoiser = await resolve(ttsLatentDenoiserSrc);
  const resolvedVoiceDecoder = await resolve(ttsVoiceDecoderSrc);
  const resolvedVoice = await resolve(ttsVoiceSrc);

  const result: TtsModelConfig = {
    ttsEngine: "supertonic",
    ttsTokenizerSrc: resolvedTokenizer,
    ttsTextEncoderSrc: resolvedTextEncoder,
    ttsLatentDenoiserSrc: resolvedLatentDenoiser,
    ttsVoiceDecoderSrc: resolvedVoiceDecoder,
    ttsVoiceSrc: resolvedVoice,
  };
  if (language) result.language = language;
  if (ttsSpeed !== undefined) result.ttsSpeed = ttsSpeed;
  if (ttsNumInferenceSteps !== undefined)
    result.ttsNumInferenceSteps = ttsNumInferenceSteps;
  return result;
}

function createChatterboxModel(
  modelId: string,
  config: TtsModelConfig,
): PluginModelResult {
  const {
    ttsTokenizerSrc: tokenizerPath,
    ttsSpeechEncoderSrc: speechEncoderPath,
    ttsEmbedTokensSrc: embedTokensPath,
    ttsConditionalDecoderSrc: conditionalDecoderPath,
    ttsLanguageModelSrc: languageModelPath,
    referenceAudioSrc: referenceAudioPath,
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
    ttsTokenizerSrc: tokenizerPath,
    ttsTextEncoderSrc: textEncoderPath,
    ttsLatentDenoiserSrc: latentDenoiserPath,
    ttsVoiceDecoderSrc: voiceDecoderPath,
    ttsVoiceSrc: voicePath,
    ttsSpeed: speed,
    ttsNumInferenceSteps: numInferenceSteps,
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

  async resolveConfig(
    modelConfig: Record<string, unknown>,
    resolve: ResolveModelPath,
  ): Promise<Record<string, unknown>> {
    const config = modelConfig as TtsModelConfig;

    if (config.ttsEngine === "supertonic") {
      return resolveSupertonicConfig(config, resolve);
    }

    return resolveChatterboxConfig(config, resolve);
  },

  createModel(params: CreateModelParams): PluginModelResult {
    const config = (params.modelConfig ?? {}) as TtsModelConfig;

    if (config.ttsEngine === "supertonic") {
      return createSupertonicModel(params.modelId, config);
    }

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
