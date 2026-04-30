import EmbedLlamacpp, { type GGMLConfig } from "@qvac/embed-llamacpp";
import embedAddonLogging from "@qvac/embed-llamacpp/addonLogging";
import {
  definePlugin,
  defineHandler,
  embedRequestSchema,
  embedResponseSchema,
  ModelType,
  embedConfigBaseSchema,
  ADDON_EMBEDDING,
  type CreateModelParams,
  type PluginModelResult,
  type EmbedConfig,
} from "@/schemas";
import { createStreamLogger, registerAddonLogger } from "@/logging";
import { expandGGUFIntoShards } from "@/server/utils";
import { embed } from "@/server/bare/ops/embed";
import { forwardModelExecution } from "@/profiling/model-execution";

function transformEmbedConfig(embedConfig: EmbedConfig): GGMLConfig {
  const config: GGMLConfig = {
    device: embedConfig.device as "gpu" | "cpu",
    gpu_layers: `${embedConfig.gpuLayers}` as `${number}`,
    batch_size: `${embedConfig.batchSize}` as `${number}`,
  };

  if (embedConfig.flashAttention) {
    config.flash_attn = embedConfig.flashAttention;
  }

  if (embedConfig.pooling) {
    config.pooling = embedConfig.pooling;
  }

  if (embedConfig.attention) {
    config.attention = embedConfig.attention;
  }

  if (typeof embedConfig.embdNormalize === "number") {
    config.embd_normalize = `${embedConfig.embdNormalize}`;
  }

  if (embedConfig.mainGpu !== undefined) {
    config["main-gpu"] =
      typeof embedConfig.mainGpu === "number"
        ? `${embedConfig.mainGpu}`
        : embedConfig.mainGpu;
  }

  if (typeof embedConfig.verbosity === "number") {
    config.verbosity = `${embedConfig.verbosity}`;
  }

  if (embedConfig.openclCacheDir) {
    config.openclCacheDir = embedConfig.openclCacheDir;
  }

  return config;
}

function createEmbeddingsModel(
  modelId: string,
  modelPath: string,
  embedConfig: EmbedConfig,
) {
  const logger = createStreamLogger(modelId, ModelType.llamacppEmbedding);
  registerAddonLogger(modelId, ModelType.llamacppEmbedding, logger);

  const config = transformEmbedConfig(embedConfig);
  const modelFiles = expandGGUFIntoShards(modelPath);

  const model = new EmbedLlamacpp({
    files: { model: modelFiles },
    config,
    logger,
    opts: { stats: true },
  });

  return { model };
}

export const embeddingsPlugin = definePlugin({
  modelType: ModelType.llamacppEmbedding,
  displayName: "Embeddings (llama.cpp)",
  addonPackage: ADDON_EMBEDDING,
  loadConfigSchema: embedConfigBaseSchema,

  createModel(params: CreateModelParams): PluginModelResult {
    const embedConfig = (params.modelConfig ?? {}) as EmbedConfig;

    const { model } = createEmbeddingsModel(
      params.modelId,
      params.modelPath,
      embedConfig,
    );

    return { model };
  },

  handlers: {
    embed: defineHandler({
      requestSchema: embedRequestSchema,
      responseSchema: embedResponseSchema,
      streaming: false,

      handler: async function (request) {
        const embedResult = await embed({
          modelId: request.modelId,
          text: request.text,
        });

        return forwardModelExecution({
          type: "embed" as const,
          success: true,
          embedding: embedResult.embedding,
          ...(embedResult.stats && { stats: embedResult.stats }),
        }, embedResult);
      },
    }),
  },

  logging: {
    module: embedAddonLogging,
    namespace: ModelType.llamacppEmbedding,
  },
});
