import parakeetAddonLogging from "@qvac/transcription-parakeet/addonLogging";
import TranscriptionParakeet, {
  type ParakeetConfig as AddonParakeetConfig,
  type TranscriptionParakeetFiles,
  type TranscriptionParakeetConfig,
} from "@qvac/transcription-parakeet";
import {
  definePlugin,
  defineHandler,
  defineDuplexHandler,
  transcribeRequestSchema,
  transcribeResponseSchema,
  transcribeStreamRequestSchema,
  transcribeStreamResponseSchema,
  ModelType,
  parakeetLoadConfigSchema,
  LEGACY_PARAKEET_ONNX_MODEL_CONFIG_FIELDS,
  ADDON_PARAKEET,
  type ParakeetConfig,
  type CreateModelParams,
  type PluginModelResult,
  type ResolveResult,
} from "@/schemas";
import { createStreamLogger, registerAddonLogger } from "@/logging";
import {
  ModelLoadFailedError,
  TranscriptionFailedError,
  LegacyParakeetModelDeprecatedError,
} from "@/utils/errors-server";
import { transcribe, transcribeStream } from "@/server/bare/ops/transcribe";
import { attachModelExecutionMs } from "@/profiling/model-execution";

function resolveParakeetConfig(
  cfg: ParakeetConfig,
): Promise<ResolveResult<ParakeetConfig>> {
  const cfgRecord = cfg as unknown as Record<string, unknown>;
  const legacyFields = LEGACY_PARAKEET_ONNX_MODEL_CONFIG_FIELDS.filter(
    (name) => cfgRecord[name] !== undefined,
  );
  if (legacyFields.length > 0) {
    throw new LegacyParakeetModelDeprecatedError(legacyFields);
  }
  return Promise.resolve({ config: cfg });
}

function createParakeetModel(params: CreateModelParams): PluginModelResult {
  const config = (params.modelConfig ?? {}) as ParakeetConfig;
  const modelPath = params.modelPath;

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

  const parakeetConfig = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined),
  ) as AddonParakeetConfig;

  const addonConfig: TranscriptionParakeetConfig = {
    enableStats: true,
    parakeetConfig,
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
  loadConfigSchema: parakeetLoadConfigSchema,

  resolveConfig(
    cfg: ParakeetConfig,
  ): Promise<ResolveResult<ParakeetConfig>> {
    return resolveParakeetConfig(cfg);
  },

  createModel(params: CreateModelParams): PluginModelResult {
    return createParakeetModel(params);
  },

  handlers: {
    transcribe: defineHandler({
      requestSchema: transcribeRequestSchema,
      responseSchema: transcribeResponseSchema,
      streaming: true,
      cancel: { scope: "model", hard: true },

      handler: async function* (request) {
        if (request.metadata === true) {
          throw new TranscriptionFailedError(
            `Parakeet transcription does not support metadata: true; only the whisper engine emits per-segment metadata. Use a whisper model to receive segments.`,
          );
        }

        const stream = transcribe(
          {
            modelId: request.modelId,
            audioChunk: request.audioChunk,
            prompt: request.prompt,
          },
          request.requestId,
        );

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

    transcribeStream: defineDuplexHandler({
      requestSchema: transcribeStreamRequestSchema,
      responseSchema: transcribeStreamResponseSchema,
      streaming: true,
      duplex: true,
      cancel: { scope: "model", hard: true },

      // TODO(QVAC-17869-followup): wire `AbortSignal` through the duplex
      // handler signature so the worker learns about consumer disconnects
      // without depending on `inputStream.end()` (which does not fire if the
      // client drops packets while TCP stays alive). Under sustained slow
      // consumers, `runStreaming` may buffer between the server generator and
      // the duplex RPC writer — backpressure is not yet characterised. Pair
      // the fix with request-lifecycle `cancel({ requestId })` routing.
      handler: async function* (request, inputStream) {
        if (request.metadata === true) {
          throw new TranscriptionFailedError(
            `Parakeet transcribeStream does not support metadata: true; only the whisper engine emits per-segment metadata.`,
          );
        }

        const streamOpts = {
          ...(request.parakeetStreamingConfig && {
            parakeetStreamingConfig: request.parakeetStreamingConfig,
          }),
        };

        const iterator = transcribeStream(
          request.modelId,
          inputStream,
          undefined,
          false,
          streamOpts,
          request.requestId,
        );

        for await (const value of iterator) {
          if (typeof value === "object" && value !== null && "type" in value) {
            if (value.type === "endOfTurn") {
              yield {
                type: "transcribeStream" as const,
                endOfTurn: { source: "parakeet" as const },
              };
            }
            continue;
          }

          yield {
            type: "transcribeStream" as const,
            text: value,
          };
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
    module: parakeetAddonLogging,
    namespace: ModelType.parakeetTranscription,
  },
});
