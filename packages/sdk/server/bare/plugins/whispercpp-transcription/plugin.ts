import whisperAddonLogging from "@qvac/transcription-whispercpp/addonLogging";
import TranscriptionWhispercpp, {
  type WhisperConfig as TranscriptionWhisperConfig,
} from "@qvac/transcription-whispercpp";
import {
  definePlugin,
  defineHandler,
  defineDuplexHandler,
  transcribeRequestSchema,
  transcribeResponseSchema,
  transcribeStreamRequestSchema,
  transcribeStreamResponseSchema,
  ModelType,
  whisperConfigSchema,
  ADDON_WHISPER,
  type CreateModelParams,
  type PluginModelResult,
  type ResolveContext,
  type TranscribeSegment,
  type WhisperConfig,
} from "@/schemas";
import { createStreamLogger, registerAddonLogger } from "@/logging";
import { transcribe, transcribeStream } from "@/server/bare/ops/transcribe";
import { attachModelExecutionMs } from "@/profiling/model-execution";

function createWhisperModel(
  modelId: string,
  modelPath: string,
  whisperConfig: WhisperConfig,
  vadModelPath?: string,
) {
  const logger = createStreamLogger(modelId, ModelType.whispercppTranscription);
  registerAddonLogger(modelId, ModelType.whispercppTranscription, logger);

  const args = {
    files: {
      model: modelPath,
      ...(vadModelPath && { vadModel: vadModelPath }),
    },
    logger,
    opts: {
      stats: true,
    },
  };

  const { contextParams, miscConfig, ...whisperParams } = whisperConfig;

  const config = {
    whisperConfig: whisperParams as TranscriptionWhisperConfig,
    ...(contextParams && { contextParams }),
    ...(miscConfig && { miscConfig }),
  };

  const model = new TranscriptionWhispercpp(args, config);

  return { model };
}

export const whisperPlugin = definePlugin({
  modelType: ModelType.whispercppTranscription,
  displayName: "Whisper (whisper.cpp)",
  addonPackage: ADDON_WHISPER,
  loadConfigSchema: whisperConfigSchema,

  async resolveConfig(cfg: WhisperConfig, ctx: ResolveContext) {
    const { vadModelSrc, ...whisperConfig } = cfg;

    if (!vadModelSrc) {
      return { config: whisperConfig };
    }

    const vadModelPath = await ctx.resolveModelPath(vadModelSrc);
    return {
      config: whisperConfig,
      artifacts: { vadModelPath },
    };
  },

  createModel(params: CreateModelParams): PluginModelResult {
    const whisperConfig = (params.modelConfig ?? {}) as WhisperConfig;

    const { model } = createWhisperModel(
      params.modelId,
      params.modelPath,
      whisperConfig,
      params.artifacts?.["vadModelPath"],
    );

    return { model };
  },

  handlers: {
    transcribe: defineHandler({
      requestSchema: transcribeRequestSchema,
      responseSchema: transcribeResponseSchema,
      streaming: true,

      handler: async function* (request) {
        const metadata = request.metadata === true;
        const stream = metadata
          ? transcribe({
              modelId: request.modelId,
              audioChunk: request.audioChunk,
              prompt: request.prompt,
              metadata: true,
            })
          : transcribe({
              modelId: request.modelId,
              audioChunk: request.audioChunk,
              prompt: request.prompt,
            });

        try {
          let result = await stream.next();
          while (!result.done) {
            yield metadata
              ? {
                  type: "transcribe" as const,
                  segment: result.value as TranscribeSegment,
                }
              : {
                  type: "transcribe" as const,
                  text: result.value as string,
                };
            result = await stream.next();
          }

          const { modelExecutionMs, stats } = result.value;
          yield attachModelExecutionMs({
            type: "transcribe" as const,
            text: "",
            done: true,
            ...(stats && { stats }),
          }, modelExecutionMs);
        } finally {
          await stream.return?.(undefined as never);
        }
      },
    }),

    transcribeStream: defineDuplexHandler({
      requestSchema: transcribeStreamRequestSchema,
      responseSchema: transcribeStreamResponseSchema,
      streaming: true,
      duplex: true,

      handler: async function* (request, inputStream) {
        if (request.metadata === true) {
          for await (const segment of transcribeStream(
            request.modelId,
            inputStream,
            request.prompt,
            true,
          )) {
            yield {
              type: "transcribeStream" as const,
              segment,
            };
          }
        } else {
          for await (const text of transcribeStream(
            request.modelId,
            inputStream,
            request.prompt,
          )) {
            yield {
              type: "transcribeStream" as const,
              text,
            };
          }
        }

        yield {
          type: "transcribeStream" as const,
          text: "",
          done: true,
        };
      },
    }),
  },

  logging: {
    module: whisperAddonLogging,
    namespace: ModelType.whispercppTranscription,
  },
});
