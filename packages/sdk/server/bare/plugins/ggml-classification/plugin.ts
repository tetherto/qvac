import ImageClassifier from "@qvac/classification-ggml";
import {
  definePlugin,
  defineHandler,
  classifyRequestSchema,
  classifyResponseSchema,
  ModelType,
  classificationConfigSchema,
  ADDON_CLASSIFICATION,
  type ClassificationConfig,
  type CreateModelParams,
  type PluginModelResult,
} from "@/schemas";
import { createStreamLogger, registerAddonLogger } from "@/logging";
import { classify } from "@/server/bare/plugins/ggml-classification/ops/classify";

export const classificationPlugin = definePlugin({
  modelType: ModelType.ggmlClassification,
  displayName: "Image Classification (GGML)",
  addonPackage: ADDON_CLASSIFICATION,
  loadConfigSchema: classificationConfigSchema,
  skipPrimaryModelPathValidation: true,

  createModel(params: CreateModelParams): PluginModelResult {
    const config = (params.modelConfig ?? {}) as ClassificationConfig;

    const resolvedModelPath = config.modelPath ?? (params.modelPath || undefined);

    const logger = createStreamLogger(params.modelId, ModelType.ggmlClassification);
    registerAddonLogger(params.modelId, ModelType.ggmlClassification, logger);

    const inner = new ImageClassifier({
      ...(resolvedModelPath ? { modelPath: resolvedModelPath } : {}),
      logger,
      nativeLogger: config.nativeLogger ?? false,
    });

    // Apply the load-time `topK` as a default for classify() calls so the
    // load-config field is not silently ignored. Per-request `topK` (passed
    // in the second arg) wins via the `...opts` spread.
    const defaultTopK = config.topK;
    const model = {
      load: () => inner.load(),
      classify: (
        image: Uint8Array,
        opts: { topK?: number; width?: number; height?: number; channels?: 3 } = {},
      ) =>
        inner.classify(image, {
          ...(defaultTopK !== undefined && { topK: defaultTopK }),
          ...opts,
        }),
      unload: () => inner.unload(),
    };

    return { model };
  },

  handlers: {
    classify: defineHandler({
      requestSchema: classifyRequestSchema,
      responseSchema: classifyResponseSchema,
      streaming: true,
      // Classification is a single forward pass with no addon-side cancel
      // surface — mirrors `ocr`/`tts`/`upscale`. The yield-once handler
      // can't be interrupted partway, so we declare scope:"none".
      cancel: { scope: "none" },

      handler: async function* (request) {
        const { results, modelExecutionMs } = await classify(request);
        yield {
          type: "classify" as const,
          results,
          done: true,
          modelExecutionMs,
        };
      },
    }),
  },
});
