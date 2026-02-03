import LlmLlamacpp, { type Loader as LlmLoader } from "@qvac/llm-llamacpp";
import type { AnyModel } from "@/server/bare/registry/model-registry";
import type { LlmConfig } from "@/schemas";
import {
  ADDON_NAMESPACES,
  registerAddonLogger,
  createStreamLogger,
} from "@/logging";
import { parseModelPath } from "@/server/utils";
import FilesystemDL from "@qvac/dl-filesystem";
import { asLoader } from "@/server/bare/utils/loader-adapter";

function transformLlmConfig(llmConfig: LlmConfig) {
  const transformed = JSON.parse(
    JSON.stringify(llmConfig, (key: string, v: unknown) =>
      key === "modelType"
        ? undefined
        : key === "stop_sequences"
          ? Array.isArray(v)
            ? v.join(", ")
            : v
          : typeof v === "number" || typeof v === "boolean"
            ? String(v)
            : v,
    ).replace(
      /"([a-z][A-Za-z]*)":/g,
      (_, key: string) =>
        `"${key.replace(/[A-Z]/g, (l: string) => `_${l.toLowerCase()}`)}":`,
    ),
  ) as Record<string, string>;

  // Rename stop_sequences to reverse_prompt for the addon
  if ("stop_sequences" in transformed) {
    transformed["reverse_prompt"] = transformed["stop_sequences"];
    delete transformed["stop_sequences"];
  }

  return transformed;
}

export function createLlmModel(
  modelId: string,
  modelPath: string,
  llmConfig: LlmConfig,
  projectionModelPath?: string,
) {
  const { dirPath, basePath } = parseModelPath(modelPath);
  const loader = new FilesystemDL({ dirPath });
  const logger = createStreamLogger(modelId, ADDON_NAMESPACES.LLAMACPP_LLM);
  registerAddonLogger(modelId, ADDON_NAMESPACES.LLAMACPP_LLM, logger);
  const llmConfigStrings = transformLlmConfig(llmConfig);

  const args = {
    loader: asLoader<LlmLoader>(loader),
    opts: { stats: true },
    logger,
    diskPath: dirPath,
    modelName: basePath,
    projectionModel: projectionModelPath
      ? parseModelPath(projectionModelPath).basePath
      : "",
    modelPath,
    modelConfig: llmConfigStrings,
  };

  const model = new LlmLlamacpp(args, llmConfigStrings) as unknown as AnyModel;

  return { model, loader };
}
