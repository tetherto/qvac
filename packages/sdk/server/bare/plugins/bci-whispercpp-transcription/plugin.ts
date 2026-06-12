import bciAddonLogging from "@qvac/bci-whispercpp/addonLogging";
import BCIWhispercpp, {
  type BCIWhispercppConfig,
} from "@qvac/bci-whispercpp";
import {
  definePlugin,
  defineHandler,
  defineDuplexHandler,
  bciTranscribeRequestSchema,
  bciTranscribeResponseSchema,
  bciTranscribeStreamRequestSchema,
  bciTranscribeStreamResponseSchema,
  ModelType,
  bciConfigSchema,
  ADDON_BCI,
  type CreateModelParams,
  type PluginModelResult,
  type BciConfig,
  type TranscribeSegment,
} from "@/schemas";
import { createStreamLogger, registerAddonLogger } from "@/logging";
import {
  bciTranscribe,
  bciTranscribeStream,
} from "@/server/bare/ops/bci-transcribe";
import { attachModelExecutionMs } from "@/profiling/model-execution";

function createBciModel(
  modelId: string,
  modelPath: string,
  bciConfig: BciConfig,
) {
  const logger = createStreamLogger(
    modelId,
    ModelType.bciWhispercppTranscription,
  );
  registerAddonLogger(modelId, ModelType.bciWhispercppTranscription, logger);

  const args = {
    files: {
      model: modelPath,
    },
    logger,
    opts: {
      stats: true,
    },
  };

  const model = new BCIWhispercpp(
    args,
    bciConfig as unknown as BCIWhispercppConfig,
  );

  return { model };
}

export const bciPlugin = definePlugin({
  modelType: ModelType.bciWhispercppTranscription,
  displayName: "BCI (whisper.cpp)",
  addonPackage: ADDON_BCI,
  loadConfigSchema: bciConfigSchema,

  createModel(params: CreateModelParams): PluginModelResult {
    const bciConfig = (params.modelConfig ?? {}) as BciConfig;

    const { model } = createBciModel(
      params.modelId,
      params.modelPath,
      bciConfig,
    );

    return { model };
  },

  handlers: {
    bciTranscribe: defineHandler({
      requestSchema: bciTranscribeRequestSchema,
      responseSchema: bciTranscribeResponseSchema,
      streaming: true,
      // The BCI addon exposes a model-wide hard cancel — the running
      // neural-signal job is interrupted on `cancel()`.
      cancel: { scope: "model", hard: true },

      handler: async function* (request) {
        const metadata = request.metadata === true;
        const stream = metadata
          ? bciTranscribe(
              {
                modelId: request.modelId,
                neuralData: request.neuralData,
                metadata: true,
              },
              request.requestId,
            )
          : bciTranscribe(
              {
                modelId: request.modelId,
                neuralData: request.neuralData,
              },
              request.requestId,
            );

        try {
          let result = await stream.next();
          while (!result.done) {
            yield metadata
              ? {
                  type: "bciTranscribe" as const,
                  segment: result.value as TranscribeSegment,
                }
              : {
                  type: "bciTranscribe" as const,
                  text: result.value as string,
                };
            result = await stream.next();
          }

          const { modelExecutionMs, stats } = result.value;
          yield attachModelExecutionMs(
            {
              type: "bciTranscribe" as const,
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

    bciTranscribeStream: defineDuplexHandler({
      requestSchema: bciTranscribeStreamRequestSchema,
      responseSchema: bciTranscribeStreamResponseSchema,
      streaming: true,
      duplex: true,
      // Same model-wide hard cancel surface as `bciTranscribe` — the BCI
      // addon's `cancel()` tears down the active stream and interrupts the
      // running window job.
      cancel: { scope: "model", hard: true },

      handler: async function* (request, inputStream) {
        const metadata = request.metadata === true;
        const iterator = metadata
          ? bciTranscribeStream(
              request.modelId,
              inputStream,
              true,
              request.streamOpts,
              request.requestId,
            )
          : bciTranscribeStream(
              request.modelId,
              inputStream,
              false,
              request.streamOpts,
              request.requestId,
            );

        for await (const value of iterator) {
          yield metadata
            ? {
                type: "bciTranscribeStream" as const,
                segment: value as TranscribeSegment,
              }
            : {
                type: "bciTranscribeStream" as const,
                text: value as string,
              };
        }

        yield {
          type: "bciTranscribeStream" as const,
          text: "",
          done: true,
        };
      },
    }),
  },

  logging: {
    module: bciAddonLogging,
    namespace: ModelType.bciWhispercppTranscription,
  },
});
