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
  type CreateModelParams,
  type PluginModelResult,
  type ResolveContext,
  type TtsChatterboxConfig,
  type TtsSupertonicConfig,
  type TtsChatterboxRuntimeConfig,
  type TtsSupertonicRuntimeConfig,
  type TtsRuntimeConfig,
} from "@/schemas";
import { createStreamLogger, registerAddonLogger } from "@/logging";
import { TtsArtifactsRequiredError } from "@/utils/errors-server";
import { textToSpeech } from "@/server/bare/plugins/ggml-tts/ops/text-to-speech";
import { textToSpeechStream } from "@/server/bare/plugins/ggml-tts/ops/text-to-speech-stream";
import { attachModelExecutionMs } from "@/profiling/model-execution";

async function resolveOptionalSrc(
  ctx: ResolveContext,
  src: unknown,
): Promise<string | undefined> {
  if (src == null) return undefined;
  return ctx.resolveModelPath(src as Parameters<typeof ctx.resolveModelPath>[0]);
}

async function resolveChatterboxConfig(
  config: TtsChatterboxConfig,
  ctx: ResolveContext,
) {
  const {
    ttsModelDirSrc,
    ttsT3ModelSrc,
    ttsS3genModelSrc,
    referenceAudioSrc,
    voicesDirSrc,
    language,
    nGpuLayers,
    useGPU,
    seed,
    streamChunkTokens,
    streamFirstChunkTokens,
    cfmSteps,
    outputSampleRate,
  } = config;

  // Either a `modelDir` containing the GGUFs, or both `t3Model` + `s3gen` are
  // required. The native engine derives turbo vs MTL from the file names
  // present inside `modelDir`.
  const hasExplicit = ttsT3ModelSrc != null && ttsS3genModelSrc != null;
  if (!ttsModelDirSrc && !hasExplicit) {
    throw new TtsArtifactsRequiredError();
  }

  const [modelDirPath, t3ModelPath, s3genModelPath, referenceAudioPath, voicesDirPath] =
    await Promise.all([
      resolveOptionalSrc(ctx, ttsModelDirSrc),
      resolveOptionalSrc(ctx, ttsT3ModelSrc),
      resolveOptionalSrc(ctx, ttsS3genModelSrc),
      resolveOptionalSrc(ctx, referenceAudioSrc),
      resolveOptionalSrc(ctx, voicesDirSrc),
    ]);

  return {
    config: {
      ttsEngine: "chatterbox",
      language,
      ...(nGpuLayers !== undefined ? { nGpuLayers } : {}),
      ...(useGPU !== undefined ? { useGPU } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(streamChunkTokens !== undefined ? { streamChunkTokens } : {}),
      ...(streamFirstChunkTokens !== undefined ? { streamFirstChunkTokens } : {}),
      ...(cfmSteps !== undefined ? { cfmSteps } : {}),
      ...(outputSampleRate !== undefined ? { outputSampleRate } : {}),
    } as TtsChatterboxRuntimeConfig,
    artifacts: {
      ...(modelDirPath ? { modelDirPath } : {}),
      ...(t3ModelPath ? { t3ModelPath } : {}),
      ...(s3genModelPath ? { s3genModelPath } : {}),
      ...(referenceAudioPath ? { referenceAudioPath } : {}),
      ...(voicesDirPath ? { voicesDirPath } : {}),
    },
  };
}

async function resolveSupertonicConfig(
  config: TtsSupertonicConfig,
  ctx: ResolveContext,
) {
  const {
    ttsModelDirSrc,
    ttsSupertonicModelSrc,
    voiceName,
    ttsSpeed,
    ttsNumInferenceSteps,
    seed,
    outputSampleRate,
    language,
  } = config;

  if (!ttsModelDirSrc && !ttsSupertonicModelSrc) {
    throw new TtsArtifactsRequiredError();
  }

  const [modelDirPath, supertonicModelPath] = await Promise.all([
    resolveOptionalSrc(ctx, ttsModelDirSrc),
    resolveOptionalSrc(ctx, ttsSupertonicModelSrc),
  ]);

  return {
    config: {
      ttsEngine: "supertonic",
      language,
      ...(ttsSpeed !== undefined ? { ttsSpeed } : {}),
      ...(ttsNumInferenceSteps !== undefined ? { ttsNumInferenceSteps } : {}),
      ...(voiceName !== undefined ? { voiceName } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(outputSampleRate !== undefined ? { outputSampleRate } : {}),
    } as TtsSupertonicRuntimeConfig,
    artifacts: {
      ...(modelDirPath ? { modelDirPath } : {}),
      ...(supertonicModelPath ? { supertonicModelPath } : {}),
    },
  };
}

function createChatterboxModel(
  modelId: string,
  config: TtsChatterboxRuntimeConfig,
  artifacts: Record<string, string | undefined>,
): PluginModelResult {
  const modelDirPath = artifacts["modelDirPath"];
  const t3ModelPath = artifacts["t3ModelPath"];
  const s3genModelPath = artifacts["s3genModelPath"];
  const referenceAudioPath = artifacts["referenceAudioPath"];
  const voicesDirPath = artifacts["voicesDirPath"];

  if (!modelDirPath && !(t3ModelPath && s3genModelPath)) {
    throw new TtsArtifactsRequiredError();
  }

  const logger = createStreamLogger(modelId, ModelType.ggmlTts);
  registerAddonLogger(modelId, ModelType.ggmlTts, logger);

  const model = new TTSGgml({
    files: {
      ...(modelDirPath ? { modelDir: modelDirPath } : {}),
      ...(t3ModelPath ? { t3Model: t3ModelPath } : {}),
      ...(s3genModelPath ? { s3genModel: s3genModelPath } : {}),
      ...(voicesDirPath ? { voicesDir: voicesDirPath } : {}),
    },
    engine: "chatterbox",
    config: {
      language: config.language ?? "en",
      ...(config.useGPU !== undefined ? { useGPU: config.useGPU } : {}),
      ...(config.outputSampleRate !== undefined
        ? { outputSampleRate: config.outputSampleRate }
        : {}),
    },
    ...(referenceAudioPath ? { referenceAudio: referenceAudioPath } : {}),
    ...(config.nGpuLayers !== undefined ? { nGpuLayers: config.nGpuLayers } : {}),
    ...(config.seed !== undefined ? { seed: config.seed } : {}),
    ...(config.streamChunkTokens !== undefined
      ? { streamChunkTokens: config.streamChunkTokens }
      : {}),
    ...(config.streamFirstChunkTokens !== undefined
      ? { streamFirstChunkTokens: config.streamFirstChunkTokens }
      : {}),
    ...(config.cfmSteps !== undefined ? { cfmSteps: config.cfmSteps } : {}),
    logger,
    opts: { stats: true },
    exclusiveRun: true,
  });
  return { model };
}

function createSupertonicModel(
  modelId: string,
  config: TtsSupertonicRuntimeConfig,
  artifacts: Record<string, string | undefined>,
): PluginModelResult {
  const modelDirPath = artifacts["modelDirPath"];
  const supertonicModelPath = artifacts["supertonicModelPath"];

  if (!modelDirPath && !supertonicModelPath) {
    throw new TtsArtifactsRequiredError();
  }

  const logger = createStreamLogger(modelId, ModelType.ggmlTts);
  registerAddonLogger(modelId, ModelType.ggmlTts, logger);

  const model = new TTSGgml({
    files: {
      ...(modelDirPath ? { modelDir: modelDirPath } : {}),
      ...(supertonicModelPath ? { supertonicModel: supertonicModelPath } : {}),
    },
    engine: "supertonic",
    config: {
      language: config.language ?? "en",
      useGPU: false,
      ...(config.outputSampleRate !== undefined
        ? { outputSampleRate: config.outputSampleRate }
        : {}),
    },
    ...(config.voiceName !== undefined ? { voiceName: config.voiceName } : {}),
    ...(config.ttsNumInferenceSteps !== undefined
      ? { numInferenceSteps: config.ttsNumInferenceSteps }
      : {}),
    ...(config.ttsSpeed !== undefined ? { speed: config.ttsSpeed } : {}),
    ...(config.seed !== undefined ? { seed: config.seed } : {}),
    logger,
    opts: { stats: true },
    exclusiveRun: true,
  });
  return { model };
}

export const ttsPlugin = definePlugin({
  modelType: ModelType.ggmlTts,
  displayName: "TTS (GGML)",
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
    namespace: ModelType.ggmlTts,
  },
});
