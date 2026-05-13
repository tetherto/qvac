import parakeetAddonLogging from "@qvac/transcription-parakeet/addonLogging";
import TranscriptionParakeet, {
  type ParakeetConfig,
  type TranscriptionParakeetFiles,
  type TranscriptionParakeetConfig,
} from "@qvac/transcription-parakeet";
import {
  definePlugin,
  defineHandler,
  transcribeRequestSchema,
  transcribeResponseSchema,
  ModelType,
  parakeetConfigSchema,
  ADDON_PARAKEET,
  type ModelSrcInput,
  type CreateModelParams,
  type PluginModelResult,
  type ResolveContext,
  type ResolveResult,
} from "@/schemas";
import { createStreamLogger, registerAddonLogger } from "@/logging";
import {
  ModelLoadFailedError,
  TranscriptionFailedError,
} from "@/utils/errors-server";
import { transcribe } from "@/server/bare/ops/transcribe";
import { attachModelExecutionMs } from "@/profiling/model-execution";

type ParakeetModelConfig = {
  maxThreads?: number;
  useGPU?: boolean;
  sampleRate?: number;
  channels?: number;
  captionEnabled?: boolean;
  timestampsEnabled?: boolean;
  seed?: number;
  streaming?: boolean;
  streamingChunkMs?: number;
  streamingHistoryMs?: number;
  streamingEmitPartials?: boolean;
  streamingEnergyVad?: boolean;
  streamingLeftContextMs?: number;
  streamingRightLookaheadMs?: number;
  // Override the primary model source. When omitted the plugin falls
  // back to `params.modelPath` (the modelSrc passed to loadModel).
  parakeetModelSrc?: ModelSrcInput;
};

async function resolveParakeetConfig(
  cfg: ParakeetModelConfig,
  ctx: ResolveContext,
): Promise<ResolveResult<ParakeetModelConfig>> {
  if (!cfg.parakeetModelSrc) {
    return { config: cfg };
  }

  const modelPath = await ctx.resolveModelPath(cfg.parakeetModelSrc);
  return {
    config: cfg,
    artifacts: {
      ...(modelPath !== undefined && { model: modelPath }),
    },
  };
}

function createParakeetModel(params: CreateModelParams): PluginModelResult {
  const config = (params.modelConfig ?? {}) as ParakeetModelConfig;
  const artifacts = { ...(params.artifacts ?? {}) };
  const modelPath = artifacts["model"] ?? params.modelPath;

  if (!modelPath) {
    throw new ModelLoadFailedError("Parakeet requires a GGUF model source");
  }

  const logger = createStreamLogger(
    params.modelId,
    ModelType.parakeetTranscription,
  );
  registerAddonLogger(params.modelId, ModelType.parakeetTranscription, logger);

  const files: TranscriptionParakeetFiles = {
    model: modelPath,
  };

  const {
    parakeetModelSrc: _omit,
    ...runtime
  } = config;
  void _omit;

  const addonConfig: TranscriptionParakeetConfig = {
    enableStats: true,
    parakeetConfig: { ...runtime } satisfies ParakeetConfig,
  };

  const model = new TranscriptionParakeet({
    files,
    config: addonConfig,
    logger,
  });

  return { model };
}

export const parakeetPlugin = definePlugin({
  modelType: ModelType.parakeetTranscription,
  displayName: "Parakeet (NVIDIA NeMo GGML)",
  addonPackage: ADDON_PARAKEET,
  loadConfigSchema: parakeetConfigSchema,
  skipPrimaryModelPathValidation: true,

  async resolveConfig(
    cfg: ParakeetModelConfig,
    ctx: ResolveContext,
  ): Promise<ResolveResult<ParakeetModelConfig>> {
    return resolveParakeetConfig(cfg, ctx);
  },

  createModel(params: CreateModelParams): PluginModelResult {
    return createParakeetModel(params);
  },

  handlers: {
    transcribe: defineHandler({
      requestSchema: transcribeRequestSchema,
      responseSchema: transcribeResponseSchema,
      streaming: true,

      handler: async function* (request) {
        if (request.metadata === true) {
          throw new TranscriptionFailedError(
            `Parakeet transcription does not support metadata: true; only the whisper engine emits per-segment metadata. Use a whisper model to receive segments.`,
          );
        }

        const stream = transcribe({
          modelId: request.modelId,
          audioChunk: request.audioChunk,
          prompt: request.prompt,
        });

        try {
          let result = await stream.next();
          while (!result.done) {
            yield {
              type: "transcribe" as const,
              text: result.value,
            };
            result = await stream.next();
          }

          const { modelExecutionMs, stats } = result.value;
          yield attachModelExecutionMs(
            {
              type: "transcribe" as const,
              text: "",
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
    module: parakeetAddonLogging,
    namespace: ModelType.parakeetTranscription,
  },
});
