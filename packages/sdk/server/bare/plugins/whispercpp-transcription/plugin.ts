import whisperAddonLogging from "@qvac/transcription-whispercpp/addonLogging";
import TranscriptionWhispercpp, {
  type WhisperConfig as TranscriptionWhisperConfig,
} from "@qvac/transcription-whispercpp";
import {
  definePlugin,
  defineHandler,
  transcribeStreamRequestSchema,
  transcribeStreamResponseSchema,
  ModelType,
  whisperConfigSchema,
  ADDON_WHISPER,
  type CreateModelParams,
  type PluginModelResult,
  type ResolveContext,
  type WhisperConfig,
} from "@/schemas";
import { createStreamLogger, registerAddonLogger } from "@/logging";
import { parseModelPath } from "@/server/utils";
import FilesystemDL from "@qvac/dl-filesystem";
import { transcribe } from "@/server/bare/ops/transcribe";
import { attachModelExecutionMs } from "@/profiling/model-execution";

function createWhisperModel(
  modelId: string,
  modelPath: string,
  whisperConfig: WhisperConfig,
  vadModelPath?: string,
) {
  const { dirPath, basePath } = parseModelPath(modelPath);

  let vadModelName = "";
  if (vadModelPath) {
    const vadParsed = parseModelPath(vadModelPath);
    vadModelName = vadParsed.basePath;
  }

  const loader = new FilesystemDL({ dirPath });
  const logger = createStreamLogger(modelId, ModelType.whispercppTranscription);
  registerAddonLogger(modelId, ModelType.whispercppTranscription, logger);

  const args = {
    loader,
    logger,
    modelName: basePath,
    diskPath: dirPath,
    vadModelName,
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

  return { model, loader };
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

    const { model, loader } = createWhisperModel(
      params.modelId,
      params.modelPath,
      whisperConfig,
      params.artifacts?.["vadModelPath"],
    );

    return { model, loader };
  },

  handlers: {
    transcribeStream: defineHandler({
      requestSchema: transcribeStreamRequestSchema,
      responseSchema: transcribeStreamResponseSchema,
      streaming: true,

      handler: async function* (request) {
        const stream = transcribe({
          modelId: request.modelId,
          audioChunk: request.audioChunk,
          prompt: request.prompt,
        });

        try {
          let result = await stream.next();
          while (!result.done) {
            yield {
              type: "transcribeStream" as const,
              text: result.value,
            };
            result = await stream.next();
          }

          const { modelExecutionMs, stats } = result.value;
          yield attachModelExecutionMs({
            type: "transcribeStream" as const,
            text: "",
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
    module: whisperAddonLogging,
    namespace: ModelType.whispercppTranscription,
  },
});
