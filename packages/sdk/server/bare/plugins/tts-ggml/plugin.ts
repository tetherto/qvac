import ttsAddonLogging from "@qvac/tts-ggml/addonLogging";
import TTSGgml from "@qvac/tts-ggml";
import {
  definePlugin,
  defineHandler,
  defineDuplexHandler,
  ttsRequestSchema,
  ttsResponseSchema,
  textToSpeechStreamRequestSchema,
  textToSpeechStreamResponseSchema,
  ModelType,
  ttsConfigSchema,
  ADDON_TTS,
  LEGACY_TTS_ONNX_MODEL_CONFIG_FIELDS,
  type CreateModelParams,
  type PluginModelResult,
  type ResolveContext,
  type ResolveResult,
  type TtsChatterboxLoadConfig,
  type TtsSupertonicLoadConfig,
  type TtsRuntimeConfig,
  type TtsChatterboxRuntimeConfig,
  type TtsSupertonicRuntimeConfig,
} from "@/schemas";
import { createStreamLogger, registerAddonLogger } from "@/logging";
import {
  TtsArtifactsRequiredError,
  LegacyTtsModelDeprecatedError,
} from "@/utils/errors-server";
import { textToSpeech } from "@/server/bare/plugins/tts-ggml/ops/text-to-speech";
import { textToSpeechStream } from "@/server/bare/plugins/tts-ggml/ops/text-to-speech-stream";
import { attachModelExecutionMs } from "@/profiling/model-execution";

function rejectLegacyOnnxFields(cfg: object) {
  const record = cfg as Record<string, unknown>;
  const legacyFields = LEGACY_TTS_ONNX_MODEL_CONFIG_FIELDS.filter(
    (name) => record[name] !== undefined,
  );
  if (legacyFields.length > 0) {
    throw new LegacyTtsModelDeprecatedError(legacyFields);
  }
}

async function resolveChatterboxConfig(
  config: TtsChatterboxLoadConfig,
  ctx: ResolveContext,
): Promise<ResolveResult<TtsRuntimeConfig>> {
  rejectLegacyOnnxFields(config);

  const { s3genModelSrc, referenceAudioSrc, ...runtime } = config;
  if (!s3genModelSrc) {
    throw new TtsArtifactsRequiredError();
  }

  const resolve = ctx.resolveModelPath;
  const [s3genPath, referenceAudioPath] = await Promise.all([
    resolve(s3genModelSrc),
    referenceAudioSrc ? resolve(referenceAudioSrc) : Promise.resolve(undefined),
  ]);

  return {
    config: runtime,
    artifacts: {
      s3genPath,
      ...(referenceAudioPath ? { referenceAudioPath } : {}),
    },
  };
}

function resolveSupertonicConfig(
  config: TtsSupertonicLoadConfig,
): Promise<ResolveResult<TtsRuntimeConfig>> {
  rejectLegacyOnnxFields(config);
  return Promise.resolve({ config });
}

function createChatterboxModel(
  modelId: string,
  config: TtsChatterboxRuntimeConfig,
  params: CreateModelParams,
  artifacts: Record<string, string | undefined>,
): PluginModelResult {
  const t3Model = params.modelPath;
  const s3genModel = artifacts["s3genPath"];
  const referenceAudioPath = artifacts["referenceAudioPath"];

  if (!t3Model || !s3genModel) {
    throw new TtsArtifactsRequiredError();
  }

  const logger = createStreamLogger(modelId, ModelType.ttsGgml);
  registerAddonLogger(modelId, ModelType.ttsGgml, logger);

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_CHATTERBOX,
    files: { t3Model, s3genModel },
    ...(referenceAudioPath ? { referenceAudio: referenceAudioPath } : {}),
    config: {
      language: config.language ?? "en",
      ...(config.useGPU !== undefined ? { useGPU: config.useGPU } : {}),
    },
    logger,
    opts: { stats: true },
    exclusiveRun: true,
  });

  return { model };
}

function createSupertonicModel(
  modelId: string,
  config: TtsSupertonicRuntimeConfig,
  params: CreateModelParams,
): PluginModelResult {
  const supertonicModel = params.modelPath;
  if (!supertonicModel) {
    throw new TtsArtifactsRequiredError();
  }

  const logger = createStreamLogger(modelId, ModelType.ttsGgml);
  registerAddonLogger(modelId, ModelType.ttsGgml, logger);

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel },
    voice: config.voice ?? "F1",
    ...(config.ttsSpeed !== undefined ? { speed: config.ttsSpeed } : {}),
    ...(config.ttsNumInferenceSteps !== undefined
      ? { numInferenceSteps: config.ttsNumInferenceSteps }
      : {}),
    config: {
      language: config.language ?? "en",
      useGPU: config.useGPU ?? false,
    },
    logger,
    opts: { stats: true },
    exclusiveRun: true,
  });

  return { model };
}

export const ttsPlugin = definePlugin({
  modelType: ModelType.ttsGgml,
  displayName: "TTS (GGML)",
  addonPackage: ADDON_TTS,
  loadConfigSchema: ttsConfigSchema,

  async resolveConfig(
    cfg: Record<string, unknown>,
    ctx: ResolveContext,
  ) {
    const { ttsEngine } = cfg as { ttsEngine?: string };

    // Same default as the former onnx-tts plugin: omitting `ttsEngine` → Chatterbox.
    if (ttsEngine === "supertonic") {
      return resolveSupertonicConfig(cfg as TtsSupertonicLoadConfig);
    }
    return resolveChatterboxConfig(cfg as TtsChatterboxLoadConfig, ctx);
  },

  createModel(params: CreateModelParams): PluginModelResult {
    const config = (params.modelConfig ?? {}) as TtsRuntimeConfig;
    const artifacts = params.artifacts ?? {};

    if (config.ttsEngine === "supertonic") {
      return createSupertonicModel(params.modelId, config, params);
    }

    return createChatterboxModel(
      params.modelId,
      config,
      params,
      artifacts,
    );
  },

  handlers: {
    textToSpeech: defineHandler({
      requestSchema: ttsRequestSchema,
      responseSchema: ttsResponseSchema,
      streaming: true,
      cancel: { scope: "model", hard: true },

      handler: async function* (request) {
        const stream = textToSpeech(request);
        try {
          let result = await stream.next();

          while (!result.done) {
            yield {
              type: "textToSpeech" as const,
              buffer: result.value.buffer,
              done: false,
              ...(result.value.chunkIndex !== undefined
                ? { chunkIndex: result.value.chunkIndex }
                : {}),
              ...(typeof result.value.sentenceChunk === "string" &&
              result.value.sentenceChunk.length > 0
                ? { sentenceChunk: result.value.sentenceChunk }
                : {}),
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

    textToSpeechStream: defineDuplexHandler({
      requestSchema: textToSpeechStreamRequestSchema,
      responseSchema: textToSpeechStreamResponseSchema,
      streaming: true,
      duplex: true,
      cancel: { scope: "model", hard: true },

      handler: async function* (request, inputStream) {
        const stream = textToSpeechStream(request, inputStream);
        try {
          let result = await stream.next();

          while (!result.done) {
            yield {
              type: "textToSpeechStream" as const,
              buffer: result.value.buffer,
              done: false,
              ...(result.value.chunkIndex !== undefined
                ? { chunkIndex: result.value.chunkIndex }
                : {}),
              ...(typeof result.value.sentenceChunk === "string" &&
              result.value.sentenceChunk.length > 0
                ? { sentenceChunk: result.value.sentenceChunk }
                : {}),
            };
            result = await stream.next();
          }

          const { modelExecutionMs, stats } = result.value;
          yield attachModelExecutionMs(
            {
              type: "textToSpeechStream" as const,
              buffer: [],
              done: true,
              ...(stats && { stats }),
            },
            modelExecutionMs,
          );
        } finally {
          await stream.return?.(undefined as never);
        }
      },
    }),
  },

  logging: {
    module: ttsAddonLogging,
    namespace: ModelType.ttsGgml,
  },
});
