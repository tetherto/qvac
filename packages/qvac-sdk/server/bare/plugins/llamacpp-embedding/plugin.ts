import EmbedLlamacpp from "@qvac/embed-llamacpp";
import embedAddonLogging from "@qvac/embed-llamacpp/addonLogging";
import {
  definePlugin,
  defineHandler,
  embedRequestSchema,
  embedResponseSchema,
  ModelType,
  type CreateModelParams,
  type PluginModelResult,
  type EmbedConfig,
} from "@/schemas";
import {
  ADDON_NAMESPACES,
  createStreamLogger,
  registerAddonLogger,
} from "@/logging";
import { parseModelPath, expandGGUFIntoShards } from "@/server/utils";
import { embed } from "@/server/bare/ops/embed";
import path from "bare-path";

function transformEmbedConfig(embedConfig: EmbedConfig): string {
  if (embedConfig.rawConfig) {
    return embedConfig.rawConfig;
  }

  const lines: string[] = [];

  lines.push(`-ngl\t${embedConfig.gpuLayers}`);
  lines.push(`-dev\t${embedConfig.device}`);
  lines.push(`--batch_size\t${embedConfig.batchSize}`);

  if (embedConfig.ctxSize) {
    lines.push(`-c\t${embedConfig.ctxSize}`);
  }

  if (embedConfig.flashAttention) {
    lines.push(`-fa\t${embedConfig.flashAttention}`);
  }

  return lines.join("\n");
}

function createEmbeddingsModel(
  modelId: string,
  modelPath: string,
  embedConfig: EmbedConfig,
) {
  const { dirPath, basePath } = parseModelPath(modelPath);
  const logger = createStreamLogger(modelId, ADDON_NAMESPACES.LLAMACPP_EMBED);
  registerAddonLogger(modelId, ADDON_NAMESPACES.LLAMACPP_EMBED, logger);

  const config = transformEmbedConfig(embedConfig);

  const shards = expandGGUFIntoShards(basePath);
  const modelFiles = shards
    ? shards.map((f) => path.join(dirPath, f))
    : [modelPath];

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
  addonPackage: "@qvac/embed-llamacpp",

  createModel(params: CreateModelParams): PluginModelResult {
    const embedConfig = (params.modelConfig ?? {}) as EmbedConfig;

    const { model } = createEmbeddingsModel(
      params.modelId,
      params.modelPath,
      embedConfig,
    );

    return { model, loader: null };
  },

  handlers: {
    embed: defineHandler({
      requestSchema: embedRequestSchema,
      responseSchema: embedResponseSchema,
      streaming: false,

      handler: async function (request) {
        const embedding = await embed({
          modelId: request.modelId,
          text: request.text,
        });

        return {
          type: "embed" as const,
          success: true,
          embedding,
        };
      },
    }),
  },

  logging: {
    module: embedAddonLogging,
    namespace: ADDON_NAMESPACES.LLAMACPP_EMBED,
  },
});
