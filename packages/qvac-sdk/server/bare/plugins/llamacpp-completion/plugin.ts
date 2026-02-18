import LlmLlamacpp, { type Loader as LlmLoader } from "@qvac/llm-llamacpp";
import llmAddonLogging from "@qvac/llm-llamacpp/addonLogging";
import {
  definePlugin,
  defineHandler,
  completionStreamRequestSchema,
  completionStreamResponseSchema,
  translateRequestSchema,
  translateResponseSchema,
  ModelType,
  type CreateModelParams,
  type PluginModelResult,
  type LlmConfig,
  type CompletionStats,
  type ToolCall,
  type TranslationStats,
} from "@/schemas";
import {
  ADDON_NAMESPACES,
  createStreamLogger,
  registerAddonLogger,
} from "@/logging";
import { parseModelPath } from "@/server/utils";
import FilesystemDL from "@qvac/dl-filesystem";
import { asLoader } from "@/server/bare/utils/loader-adapter";
import { completion } from "@/server/bare/plugins/llamacpp-completion/ops/completion-stream";
import { translate } from "@/server/bare/ops/translate";

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

  if ("stop_sequences" in transformed) {
    transformed["reverse_prompt"] = transformed["stop_sequences"];
    delete transformed["stop_sequences"];
  }

  return transformed;
}

function createLlmModel(
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

  const model = new LlmLlamacpp(args, llmConfigStrings);

  return { model, loader };
}

export const llmPlugin = definePlugin({
  modelType: ModelType.llamacppCompletion,
  displayName: "LLM (llama.cpp)",
  addonPackage: "@qvac/llm-llamacpp",

  createModel(params: CreateModelParams): PluginModelResult {
    const llmConfig = (params.modelConfig ?? {}) as LlmConfig;

    const { model, loader } = createLlmModel(
      params.modelId,
      params.modelPath,
      llmConfig,
      params.artifacts?.["projectionModelPath"],
    );

    return { model, loader };
  },

  handlers: {
    completionStream: defineHandler({
      requestSchema: completionStreamRequestSchema,
      responseSchema: completionStreamResponseSchema,
      streaming: true,

      handler: async function* (request) {
        const filteredHistory = request.history.map(
          ({ role, content, attachments }) => ({
            role,
            content,
            attachments: attachments ?? [],
          }),
        );

        const stream = completion({
          history: filteredHistory,
          modelId: request.modelId,
          kvCache: request.kvCache,
          ...(request.tools && { tools: request.tools }),
        });

        let stats: CompletionStats | undefined;
        let toolCalls: ToolCall[] = [];
        let done = false;
        let buffer = "";

        while (!done) {
          const result = await stream.next();

          if (result.done) {
            stats = result.value.stats;
            toolCalls = result.value.toolCalls;
            done = true;
          } else {
            if (request.stream) {
              yield {
                type: "completionStream" as const,
                token: result.value.token,
                ...(result.value.toolCallEvent && {
                  toolCallEvent: result.value.toolCallEvent,
                }),
              };
            } else {
              buffer += result.value.token;
            }
          }
        }

        yield {
          type: "completionStream" as const,
          token: request.stream ? "" : buffer,
          done: true,
          ...(stats && { stats }),
          ...(toolCalls.length > 0 && { toolCalls }),
        };
      },
    }),

    translate: defineHandler({
      requestSchema: translateRequestSchema,
      responseSchema: translateResponseSchema,
      streaming: true,

      handler: async function* (request) {
        const stream = translate(request);
        let done = false;
        let stats: TranslationStats | undefined;

        while (!done) {
          const result = await stream.next();

          if (result.done) {
            stats = result.value;
            done = true;
          } else {
            yield {
              type: "translate" as const,
              token: result.value,
            };
          }
        }

        yield {
          type: "translate" as const,
          token: "",
          done: true,
          ...(stats && { stats }),
        };
      },
    }),
  },

  logging: {
    module: llmAddonLogging,
    namespace: ADDON_NAMESPACES.LLAMACPP_LLM,
  },
});
