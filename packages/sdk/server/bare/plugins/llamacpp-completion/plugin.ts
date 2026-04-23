import LlmLlamacpp, { type Loader as LlmLoader } from "@qvac/llm-llamacpp";
import llmAddonLogging from "@qvac/llm-llamacpp/addonLogging";
import {
  definePlugin,
  defineHandler,
  finetuneRequestSchema,
  completionStreamRequestSchema,
  completionStreamResponseSchema,
  finetuneResponseSchema,
  translateRequestSchema,
  translateResponseSchema,
  ModelType,
  llmConfigBaseSchema,
  ADDON_LLM,
  type CompletionEvent,
  type CreateModelParams,
  type PluginCapabilities,
  type PluginModelResult,
  type ResolveContext,
  type LlmConfig,
  type LlmConfigInput,
} from "@/schemas";
import { createStreamLogger, registerAddonLogger } from "@/logging";
import { parseModelPath } from "@/server/utils";
import FilesystemDL from "@qvac/dl-filesystem";
import { asLoader } from "@/server/bare/utils/loader-adapter";
import { completion } from "@/server/bare/plugins/llamacpp-completion/ops/completion-stream";
import { finetune } from "@/server/bare/plugins/llamacpp-completion/ops/finetune";
import { translate } from "@/server/bare/ops/translate";
import { attachModelExecutionMs } from "@/profiling/model-execution";
import { getModelConfig } from "@/server/bare/registry/model-registry";
import { createCompletionNormalizer } from "@/server/utils/completion-normalizer";

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

  if ("opencl_cache_dir" in transformed) {
    transformed["openclCacheDir"] = transformed["opencl_cache_dir"];
    delete transformed["opencl_cache_dir"];
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
  const logger = createStreamLogger(modelId, ModelType.llamacppCompletion);
  registerAddonLogger(modelId, ModelType.llamacppCompletion, logger);
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
  addonPackage: ADDON_LLM,
  loadConfigSchema: llmConfigBaseSchema,

  async resolveConfig(cfg: LlmConfigInput, ctx: ResolveContext) {
    const { projectionModelSrc, ...llmConfig } = cfg;

    if (!projectionModelSrc) {
      return { config: llmConfig };
    }

    const projectionModelPath = await ctx.resolveModelPath(projectionModelSrc);
    return {
      config: llmConfig,
      artifacts: { projectionModelPath },
    };
  },

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

        const modelCfg = getModelConfig(request.modelId);
        const toolsActive =
          (request.tools?.length ?? 0) > 0 &&
          (modelCfg as { tools?: boolean }).tools === true;

        const capabilities: PluginCapabilities = {
          toolCalling: toolsActive ? "textParse" : "none",
          thinkingFraming: request.captureThinking ? "thinkTags" : "none",
        };

        const normalizer = createCompletionNormalizer({
          capabilities,
          tools: request.tools ?? [],
          captureThinking: request.captureThinking ?? false,
          emitRawDeltas: request.emitRawDeltas ?? false,
        });

        const stream = completion({
          history: filteredHistory,
          modelId: request.modelId,
          kvCache: request.kvCache,
          ...(toolsActive && request.tools && { tools: request.tools }),
          ...(request.generationParams && { generationParams: request.generationParams }),
        });

        try {
          const batchedEvents: CompletionEvent[] = [];
          let result = await stream.next();

          while (!result.done) {
            const events = normalizer.push(result.value.token);

            if (request.stream) {
              yield {
                type: "completionStream" as const,
                events,
              };
            } else {
              batchedEvents.push(...events);
            }
            result = await stream.next();
          }

          const { modelExecutionMs, stats, toolCalls } = result.value;
          const terminalEvents = normalizer.finish({
            ...(stats && { stats }),
            ...(toolCalls.length > 0 && { toolCalls }),
          });

          if (!request.stream) {
            batchedEvents.push(...terminalEvents);
          }

          const finalEvents = request.stream ? terminalEvents : batchedEvents;

          yield attachModelExecutionMs({
            type: "completionStream" as const,
            done: true,
            events: finalEvents,
          }, modelExecutionMs);
        } finally {
          await stream.return?.(undefined as never);
        }
      },
    }),

    finetune: defineHandler({
      requestSchema: finetuneRequestSchema,
      responseSchema: finetuneResponseSchema,
      streaming: false,

      handler: function (request) {
        return finetune(request);
      },
    }),

    translate: defineHandler({
      requestSchema: translateRequestSchema,
      responseSchema: translateResponseSchema,
      streaming: true,

      handler: async function* (request) {
        const stream = translate(request);
        try {
          let result = await stream.next();

          while (!result.done) {
            yield {
              type: "translate" as const,
              token: result.value,
            };
            result = await stream.next();
          }

          const { modelExecutionMs, stats } = result.value;
          yield attachModelExecutionMs({
            type: "translate" as const,
            token: "",
            done: true,
            ...(stats && { stats }),
          }, modelExecutionMs);
        } finally {
          await stream.return?.(undefined as never);
        }
      },
    }),
  },

  logging: {
    module: llmAddonLogging,
    namespace: ModelType.llamacppCompletion,
  },
});
