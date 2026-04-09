import path from "bare-path";
import ttsAddonLogging from "@qvac/tts-onnx/addonLogging";
import ONNXTTS from "@qvac/tts-onnx";
import {
  definePlugin,
  defineHandler,
  ttsRequestSchema,
  ttsResponseSchema,
  ModelType,
  ttsConfigSchema,
  ADDON_TTS,
  type CreateModelParams,
  type PluginModelResult,
  type ResolveContext,
  type TtsChatterboxConfig,
  type TtsSupertonicConfig,
  type TtsChatterboxRuntimeConfig,
  type TtsSupertonicRuntimeConfig,
  type TtsRuntimeConfig,
  type TtsEnhancerConfig,
} from "@/schemas";
import { createStreamLogger, registerAddonLogger } from "@/logging";
import {
  TtsArtifactsRequiredError,
  TtsReferenceAudioRequiredError,
} from "@/utils/errors-server";
import { textToSpeech } from "@/server/bare/plugins/onnx-tts/ops/text-to-speech";
import { attachModelExecutionMs } from "@/profiling/model-execution";
import { loadReferenceAudioAt24k } from "@/server/bare/plugins/onnx-tts/wav-helper";

async function resolveEnhancerArtifacts(
  enhancer: TtsEnhancerConfig | undefined,
  resolve: ResolveContext["resolveModelPath"],
) {
  if (!enhancer) return {};

  switch (enhancer.type) {
    case "lavasr": {
      const [enhancerBackbonePath, enhancerSpecHeadPath, denoiserPath] = await Promise.all([
        resolve(enhancer.backboneSrc),
        resolve(enhancer.specHeadSrc),
        enhancer.denoiserSrc ? resolve(enhancer.denoiserSrc) : undefined,
      ]);
      return {
        enhancerBackbonePath,
        enhancerSpecHeadPath,
        ...(denoiserPath && { denoiserPath }),
      };
    }
  }
}

function buildRuntimeEnhancer(enhancer: TtsEnhancerConfig | undefined) {
  if (!enhancer) return undefined;
  switch (enhancer.type) {
    case "lavasr":
      return {
        type: "lavasr" as const,
        enhance: enhancer.enhance ?? false,
        denoise: enhancer.denoise ?? false,
      };
  }
}

function buildEnhancerArg(
  enhancer: { type: "lavasr"; enhance?: boolean | undefined; denoise?: boolean | undefined } | undefined,
  artifacts: Record<string, string | undefined>,
) {
  if (!enhancer) return undefined;

  switch (enhancer.type) {
    case "lavasr": {
      const backbonePath = artifacts["enhancerBackbonePath"];
      const specHeadPath = artifacts["enhancerSpecHeadPath"];
      if (!backbonePath || !specHeadPath) return undefined;
      return {
        type: "lavasr" as const,
        ...(enhancer.enhance !== undefined && { enhance: enhancer.enhance }),
        ...(enhancer.denoise !== undefined && { denoise: enhancer.denoise }),
        backbonePath,
        specHeadPath,
        ...(artifacts["denoiserPath"] && { denoiserPath: artifacts["denoiserPath"] }),
      };
    }
  }
}

async function resolveChatterboxConfig(
  config: TtsChatterboxConfig,
  ctx: ResolveContext,
) {
  const {
    ttsTokenizerSrc,
    ttsSpeechEncoderSrc,
    ttsEmbedTokensSrc,
    ttsConditionalDecoderSrc,
    ttsLanguageModelSrc,
    referenceAudioSrc,
    language,
    enhancer,
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

  const resolve = ctx.resolveModelPath;
  const [
    tokenizerPath,
    speechEncoderPath,
    embedTokensPath,
    conditionalDecoderPath,
    languageModelPath,
    referenceAudioPath,
  ] = await Promise.all([
    resolve(ttsTokenizerSrc),
    resolve(ttsSpeechEncoderSrc),
    resolve(ttsEmbedTokensSrc),
    resolve(ttsConditionalDecoderSrc),
    resolve(ttsLanguageModelSrc),
    resolve(referenceAudioSrc),
  ]);

  const enhancerArtifacts = await resolveEnhancerArtifacts(enhancer, resolve);
  const runtimeEnhancer = buildRuntimeEnhancer(enhancer);

  return {
    config: {
      ttsEngine: "chatterbox",
      language,
      ...(runtimeEnhancer && { enhancer: runtimeEnhancer }),
    } as TtsChatterboxRuntimeConfig,
    artifacts: {
      tokenizerPath,
      speechEncoderPath,
      embedTokensPath,
      conditionalDecoderPath,
      languageModelPath,
      referenceAudioPath,
      ...enhancerArtifacts,
    },
  };
}

async function resolveSupertonicConfig(
  config: TtsSupertonicConfig,
  ctx: ResolveContext,
) {
  const {
    ttsTextEncoderSrc,
    ttsDurationPredictorSrc,
    ttsVectorEstimatorSrc,
    ttsVocoderSrc,
    ttsUnicodeIndexerSrc,
    ttsTtsConfigSrc,
    ttsVoiceStyleSrc,
    ttsSpeed,
    ttsNumInferenceSteps,
    ttsSupertonicMultilingual,
    language,
    enhancer,
  } = config;

  if (
    !ttsTextEncoderSrc ||
    !ttsDurationPredictorSrc ||
    !ttsVectorEstimatorSrc ||
    !ttsVocoderSrc ||
    !ttsUnicodeIndexerSrc ||
    !ttsTtsConfigSrc ||
    !ttsVoiceStyleSrc
  ) {
    throw new TtsArtifactsRequiredError();
  }

  const resolve = ctx.resolveModelPath;
  const [
    textEncoderPath,
    durationPredictorPath,
    vectorEstimatorPath,
    vocoderPath,
    unicodeIndexerPath,
    ttsConfigPath,
    voiceStylePath,
  ] = await Promise.all([
    resolve(ttsTextEncoderSrc),
    resolve(ttsDurationPredictorSrc),
    resolve(ttsVectorEstimatorSrc),
    resolve(ttsVocoderSrc),
    resolve(ttsUnicodeIndexerSrc),
    resolve(ttsTtsConfigSrc),
    resolve(ttsVoiceStyleSrc),
  ]);

  const enhancerArtifacts = await resolveEnhancerArtifacts(enhancer, resolve);
  const runtimeEnhancer = buildRuntimeEnhancer(enhancer);

  return {
    config: {
      ttsEngine: "supertonic",
      language,
      ttsSpeed,
      ttsNumInferenceSteps,
      ttsSupertonicMultilingual,
      ...(runtimeEnhancer && { enhancer: runtimeEnhancer }),
    } as TtsSupertonicRuntimeConfig,
    artifacts: {
      textEncoderPath,
      durationPredictorPath,
      vectorEstimatorPath,
      vocoderPath,
      unicodeIndexerPath,
      ttsConfigPath,
      voiceStylePath,
      ...enhancerArtifacts,
    },
  };
}

function createChatterboxModel(
  modelId: string,
  config: TtsChatterboxRuntimeConfig,
  artifacts: Record<string, string | undefined>,
): PluginModelResult {
  const tokenizerPath = artifacts["tokenizerPath"];
  const speechEncoderPath = artifacts["speechEncoderPath"];
  const embedTokensPath = artifacts["embedTokensPath"];
  const conditionalDecoderPath = artifacts["conditionalDecoderPath"];
  const languageModelPath = artifacts["languageModelPath"];
  const referenceAudioPath = artifacts["referenceAudioPath"];

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

  const logger = createStreamLogger(modelId, ModelType.onnxTts);
  registerAddonLogger(modelId, ModelType.onnxTts, logger);
  const referenceAudio = loadReferenceAudioAt24k(referenceAudioPath);
  const enhancerArg = buildEnhancerArg(config.enhancer, artifacts);
  const model = new ONNXTTS({
    files: {
      tokenizerPath,
      speechEncoderPath,
      embedTokensPath,
      conditionalDecoderPath,
      languageModelPath,
    },
    engine: "chatterbox",
    config: { language: config.language ?? "en", useGPU: false },
    referenceAudio,
    logger,
    opts: { stats: true },
    exclusiveRun: true,
    ...(enhancerArg && { enhancer: enhancerArg }),
  } as never);
  return { model, loader: undefined };
}

function createSupertonicModel(
  modelId: string,
  config: TtsSupertonicRuntimeConfig,
  artifacts: Record<string, string | undefined>,
): PluginModelResult {
  const textEncoderPath = artifacts["textEncoderPath"];
  const durationPredictorPath = artifacts["durationPredictorPath"];
  const vectorEstimatorPath = artifacts["vectorEstimatorPath"];
  const vocoderPath = artifacts["vocoderPath"];
  const unicodeIndexerPath = artifacts["unicodeIndexerPath"];
  const ttsConfigPath = artifacts["ttsConfigPath"];
  const voiceStylePath = artifacts["voiceStylePath"];

  if (
    !textEncoderPath ||
    !durationPredictorPath ||
    !vectorEstimatorPath ||
    !vocoderPath ||
    !unicodeIndexerPath ||
    !ttsConfigPath ||
    !voiceStylePath
  ) {
    throw new TtsArtifactsRequiredError();
  }

  const logger = createStreamLogger(modelId, ModelType.onnxTts);
  registerAddonLogger(modelId, ModelType.onnxTts, logger);
  const voiceName = path.basename(voiceStylePath).replace(/\.json$/i, "") || "F1";
  const enhancerArg = buildEnhancerArg(config.enhancer, artifacts);
  const model = new ONNXTTS({
    files: {
      textEncoderPath,
      durationPredictorPath,
      vectorEstimatorPath,
      vocoderPath,
      unicodeIndexerPath,
      ttsConfigPath,
      voiceStyleJsonPath: voiceStylePath,
    },
    engine: "supertonic",
    voiceName,
    speed: config.ttsSpeed ?? 1,
    numInferenceSteps: config.ttsNumInferenceSteps ?? 5,
    supertonicMultilingual: config.ttsSupertonicMultilingual !== false,
    config: { language: config.language ?? "en" },
    logger,
    opts: { stats: true },
    exclusiveRun: true,
    ...(enhancerArg && { enhancer: enhancerArg }),
  } as never);
  return { model, loader: undefined };
}

export const ttsPlugin = definePlugin({
  modelType: ModelType.onnxTts,
  displayName: "TTS (ONNX)",
  addonPackage: ADDON_TTS,
  loadConfigSchema: ttsConfigSchema,
  skipPrimaryModelPathValidation: true,

  async resolveConfig(
    cfg: Record<string, unknown>,
    ctx: ResolveContext,
  ) {
    const { ttsEngine } = cfg as { ttsEngine?: string };

    if (ttsEngine === "supertonic") {
      return resolveSupertonicConfig(cfg as TtsSupertonicConfig, ctx);
    }
    return resolveChatterboxConfig(cfg as TtsChatterboxConfig, ctx);
  },

  createModel(params: CreateModelParams): PluginModelResult {
    const config = (params.modelConfig ?? {}) as TtsRuntimeConfig;
    const artifacts = params.artifacts ?? {};

    if (config.ttsEngine === "supertonic") {
      return createSupertonicModel(params.modelId, config, artifacts);
    }

    return createChatterboxModel(params.modelId, config, artifacts);
  },

  handlers: {
    textToSpeech: defineHandler({
      requestSchema: ttsRequestSchema,
      responseSchema: ttsResponseSchema,
      streaming: true,

      handler: async function* (request) {
        const stream = textToSpeech(request);
        try {
          let result = await stream.next();

          while (!result.done) {
            yield {
              type: "textToSpeech" as const,
              buffer: result.value.buffer,
              done: false,
            };
            result = await stream.next();
          }

          const { modelExecutionMs, stats } = result.value;
          yield attachModelExecutionMs({
            type: "textToSpeech" as const,
            buffer: [],
            done: true,
            ...(stats && { stats }),
          }, modelExecutionMs);
        } finally {
          await stream.return?.(undefined as never);
        }
      },
    }),
  },

  logging: {
    module: ttsAddonLogging,
    namespace: ModelType.onnxTts,
  },
});
