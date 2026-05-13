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
  parakeetConfigSchema,
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
} from "@/utils/errors-server";
import { transcribe, transcribeStream } from "@/server/bare/ops/transcribe";
import { attachModelExecutionMs } from "@/profiling/model-execution";

function resolveParakeetConfig(
  cfg: ParakeetConfig,
): Promise<ResolveResult<ParakeetConfig>> {
  // Parakeet 0.4+ ships as a single GGUF, supplied via the top-level
  // `modelSrc` of `loadModel`. The plugin doesn't need to resolve any
  // additional artifact paths here — `createModel` consumes
  // `params.modelPath` directly.
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

  // The SDK's Zod-inferred `ParakeetConfig` types optional fields as
  // `T | undefined`, while the addon's `ParakeetConfig` types them as
  // `T?` (without an explicit `undefined`). Under
  // `exactOptionalPropertyTypes` the two aren't directly assignable,
  // and passing `undefined` keys through to the native addon can also
  // mask "use the default" intent. Strip undefined entries before
  // forwarding.
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
  loadConfigSchema: parakeetConfigSchema,
  skipPrimaryModelPathValidation: true,

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

    transcribeStream: defineDuplexHandler({
      requestSchema: transcribeStreamRequestSchema,
      responseSchema: transcribeStreamResponseSchema,
      streaming: true,
      duplex: true,

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

        // `prompt` is whisper-only; pass `undefined` so the op does
        // not even attempt to apply it.
        const iterator = transcribeStream(
          request.modelId,
          inputStream,
          undefined,
          false,
          streamOpts,
        );

        // Parakeet's duplex stream emits text segments plus synthetic
        // `endOfTurn` events derived from the EOU model's `<EOU>`
        // boundary flag. The addon does NOT surface separate VAD
        // `speaking`/`probability` events; the
        // `parakeetStreamingConfig.emitEnergyVad` knob is purely an
        // engine-internal hint that influences how parakeet-cpp
        // segments speech (it changes segmentation cadence, not the
        // event shape). Whisper is the only engine that emits
        // standalone `vad` events.
        for await (const value of iterator) {
          if (typeof value === "object" && value !== null && "type" in value) {
            if (value.type === "endOfTurn") {
              // Parakeet's EOU is token-driven; there is no measured
              // silence to report. We forward an empty endOfTurn
              // payload (silenceDurationMs is whisper-only).
              yield {
                type: "transcribeStream" as const,
                endOfTurn: {},
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
