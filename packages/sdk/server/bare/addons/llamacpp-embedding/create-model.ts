import EmbedLlamacpp, {
  type Loader as EmbedLoader,
} from "@qvac/embed-llamacpp";
import type { AnyModel } from "@/server/bare/registry/model-registry";
import type { EmbedConfig } from "@/schemas";
import {
  ADDON_NAMESPACES,
  registerAddonLogger,
  createStreamLogger,
} from "@/logging";
import { parseModelPath } from "@/server/utils";
import FilesystemDL from "@qvac/dl-filesystem";
import { asLoader } from "@/server/bare/utils/loader-adapter";

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

export function createEmbeddingsModel(
  modelId: string,
  modelPath: string,
  embedConfig: EmbedConfig,
) {
  const { dirPath, basePath } = parseModelPath(modelPath);
  const loader = new FilesystemDL({ dirPath });
  const logger = createStreamLogger(modelId, ADDON_NAMESPACES.LLAMACPP_EMBED);
  registerAddonLogger(modelId, ADDON_NAMESPACES.LLAMACPP_EMBED, logger);

  const config = transformEmbedConfig(embedConfig);

  const args = {
    loader: asLoader<EmbedLoader>(loader),
    opts: { stats: true },
    logger,
    diskPath: dirPath,
    modelName: basePath,
    modelPath,
  };

  const model = new EmbedLlamacpp(args, config) as unknown as AnyModel;

  return { model, loader };
}
