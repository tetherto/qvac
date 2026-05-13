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
  // Parakeet 0.4+ ships as a single GGUF, supplied via the top-level
  // `modelSrc` of `loadModel`. The plugin doesn't need to resolve any
  // additional artifact paths here — `createModel` consumes
  // `params.modelPath` directly.
  //
  // Detect any pre-0.4 ONNX-era `modelConfig` fields and surface a
  // structured `LegacyParakeetModelDeprecatedError` with migration
  // guidance. `parakeetLoadConfigSchema` (used by `loadModel`)
  // explicitly allow-lists these field names so they reach this
  // resolver instead of being rejected by Zod with an opaque
  // "Unrecognized key" error.
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
  loadConfigSchema: parakeetLoadConfigSchema,
  // `skipPrimaryModelPathValidation` intentionally omitted (defaults to
  // false). Parakeet 0.4+ ships as a single GGUF that the addon mmaps
  // from `params.modelPath` inside `createModel`, so we want the
  // framework's standard primary-path file check to run.

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

      // TODO(QVAC-17869-followup): wire `AbortSignal` through the
      // duplex handler signature so the worker learns about consumer
      // disconnects without depending on `inputStream.end()`. Today
      // the only signals are (a) `inputStream` ending — which does
      // NOT fire if the client is dropping packets while TCP stays
      // alive — and (b) the iterator unwinding when the consumer
      // throws. Under sustained slow consumers (e.g. mobile under
      // thermal throttling), `runStreaming` yields buffer between the
      // server generator and the duplex RPC writer; backpressure
      // characteristics are not yet captured here. Pair the
      // `AbortSignal` plumbing with the request-lifecycle migration
      // (see `request-lifecycle-primitives.mdc`, kind:
      // `"transcribeStream"`) so cancellation routes through
      // `RequestRegistry.cancel({ requestId })`.
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
              // silence to report. The discriminated `source` field
              // tags the event as parakeet-shaped so consumers can
              // narrow correctly — `silenceDurationMs` is whisper-only
              // by schema construction (see `endOfTurnEventSchema`).
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
