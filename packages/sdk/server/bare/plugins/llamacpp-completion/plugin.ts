import LlmLlamacpp from "@qvac/llm-llamacpp";
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
import { expandGGUFIntoShards } from "@/server/utils";
import { completion } from "@/server/bare/plugins/llamacpp-completion/ops/completion-stream";
import { finetune } from "@/server/bare/plugins/llamacpp-completion/ops/finetune";
import { translate } from "@/server/bare/ops/translate";
import { transformLlmConfig } from "@/server/bare/plugins/llamacpp-completion/transform";
import { attachModelExecutionMs } from "@/profiling/model-execution";
import { getModelConfig } from "@/server/bare/registry/model-registry";
import { createCompletionNormalizer } from "@/server/utils/completion-normalizer";
import { detectToolDialect } from "@/server/utils/tool-integration";
import {
  getRequestRegistry,
  withRequestContext,
} from "@/server/bare/runtime";
import { generateServerRequestId } from "@/server/bare/runtime/request-id";
import { getServerLogger } from "@/logging";
import { ContextOverflowError } from "@/utils/errors-server";
import {
  isAddonContextOverflowError,
  parseContextOverflowMessage,
} from "@/server/bare/plugins/llamacpp-completion/ops/context-overflow";
import { isMobile } from "@/server/bare/registry/runtime-context-registry";
import { stripMultiGpuKeys } from "@/server/utils/multi-gpu-mobile";


function createLlmModel(
  modelId: string,
  modelPath: string,
  llmConfig: LlmConfig,
  projectionModelPath?: string,
) {
  const logger = createStreamLogger(modelId, ModelType.llamacppCompletion);
  registerAddonLogger(modelId, ModelType.llamacppCompletion, logger);
  const llmConfigStrings = transformLlmConfig(llmConfig);

  if (isMobile()) {
    const stripped = stripMultiGpuKeys(llmConfigStrings);
    if (stripped.length > 0) {
      getServerLogger().warn(
        `[${ModelType.llamacppCompletion}:${modelId}] Multi-GPU parameters (${stripped.join(", ")}) are not supported on mobile (single-GPU device) — removing from config; model will load with single-GPU defaults`,
      );
    }
  }

  const modelFiles = expandGGUFIntoShards(modelPath);

  const model = new LlmLlamacpp({
    files: {
      model: modelFiles,
      ...(projectionModelPath && { projectionModel: projectionModelPath }),
    },
    config: llmConfigStrings,
    logger,
    opts: { stats: true },
  });

  return { model };
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

    const { model } = createLlmModel(
      params.modelId,
      params.modelPath,
      llmConfig,
      params.artifacts?.["projectionModelPath"],
    );

    return { model };
  },

  handlers: {
    completionStream: defineHandler({
      requestSchema: completionStreamRequestSchema,
      responseSchema: completionStreamResponseSchema,
      streaming: true,
      cancel: { scope: "model", hard: true },

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

        // Dialect runs regardless of tool availability — thinking/content
        // stripping is needed even on plain completions.
        const dialect =
          request.toolDialect ?? detectToolDialect(request.modelId);

        const normalizer = createCompletionNormalizer({
          capabilities,
          tools: request.tools ?? [],
          captureThinking: request.captureThinking ?? false,
          emitRawDeltas: request.emitRawDeltas ?? false,
          toolDialect: dialect,
        });

        // Open a request-scoped lifecycle. The registry is the single
        // source of truth for "is this turn cancelled?" — we plumb the
        // signal into `completion()` and expose `requestId` so the
        // client can target this run with `cancel({ requestId })`.
        // Falls back to a server-generated id if the client (e.g. an
        // older release) didn't send one.
        await using ctx = await getRequestRegistry().begin({
          requestId: request.requestId ?? generateServerRequestId(),
          kind: "completion",
          modelId: request.modelId,
        });

        const requestLogger = withRequestContext(getServerLogger(), ctx);

        // begin() can return already-aborted when the client cancels while
        // this completion is queued behind another same-model one. It never
        // decoded, so it must not touch the shared native context — emit a
        // cancelled terminal and return. Boolean(...) keeps ctx.signal.aborted
        // a boolean so the mid-stream check below isn't narrowed to false.
        const abortedBeforeRun = Boolean(ctx.signal.aborted);
        if (abortedBeforeRun) {
          yield {
            type: "completionStream" as const,
            done: true,
            events: normalizer.finish({ stopReason: "cancelled" as const }),
          };
          return;
        }

        const stream = completion(
          {
            history: filteredHistory,
            modelId: request.modelId,
            kvCache: request.kvCache,
            ...(toolsActive && request.tools && { tools: request.tools }),
            ...(request.generationParams && { generationParams: request.generationParams }),
            ...(toolsActive && { toolDialect: dialect }),
            ...(request.responseFormat && { responseFormat: request.responseFormat }),
          },
          { signal: ctx.signal, scope: ctx.scope, logger: requestLogger },
        );

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
          // Cancellation rides the done path: observable via the last event's
          // stopReason; client aggregates reject with InferenceCancelledError.
          const cancelled = ctx.signal.aborted;
          // EOS tokens are not decoded by llama_decode, so n_eval (and
          // therefore stats.generatedTokens) counts only real decode calls.
          // When generatedTokens >= effectivePredict the run exhausted its
          // token budget without hitting EOS — emit stopReason "length".
          // -1 (unlimited) and -2 (context fill) must never trigger this.
          const effectivePredict =
            request.generationParams?.predict ??
            (modelCfg as LlmConfig).predict;
          const stoppedByBudget =
            !cancelled &&
            effectivePredict !== undefined &&
            effectivePredict > 0 &&
            stats?.generatedTokens !== undefined &&
            stats.generatedTokens >= effectivePredict;
          const terminalEvents = normalizer.finish({
            ...(stats && { stats }),
            ...(toolCalls.length > 0 && { toolCalls }),
            ...(cancelled && { stopReason: "cancelled" as const }),
            ...(stoppedByBudget && { stopReason: "length" as const }),
          });

          if (!request.stream) {
            batchedEvents.push(...terminalEvents);
          }

          const finalEvents = request.stream ? terminalEvents : batchedEvents;

          yield attachModelExecutionMs(
            {
              type: "completionStream" as const,
              done: true,
              events: finalEvents,
            },
            modelExecutionMs,
          );
        } catch (err) {
          // The llama.cpp addon emits a structured `ContextOverflow` status
          // (LlmErrors.hpp::ContextOverflow = 14) when the prompt exceeds
          // the model's `ctx_size`. Bare's `js_throw_error(env, code, msg)`
          // surfaces it as a JS Error with `.code = "[ <addonId> :: ContextOverflow ]"`
          // and `.message` carrying the C++-formatted detail. Rethrow as
          // a typed `ContextOverflowError` so consumers can switch on the
          // class (and `err.code === SDK_SERVER_ERROR_CODES.CONTEXT_OVERFLOW`)
          // instead of substring-matching on the raw addon message.
          if (isAddonContextOverflowError(err)) {
            const { promptTokens, ctxSize } = parseContextOverflowMessage(
              err instanceof Error ? err.message : "",
            );
            throw new ContextOverflowError(
              promptTokens,
              ctxSize,
              request.modelId,
              err,
            );
          }
          throw err;
        } finally {
          await stream.return?.(undefined as never);
        }
      },
    }),

    finetune: defineHandler({
      requestSchema: finetuneRequestSchema,
      responseSchema: finetuneResponseSchema,
      streaming: false,
      // Reality matches addon: llama.cpp exposes `model.cancel()` for
      // the running finetune job, so we flip from `scope: "none"` to
      // `{ scope: "model", hard: true }`. The `startFinetune` op
      // forwards the registry's abort signal to that call; the broad
      // `cancel({ modelId, kind: "finetune" })` and legacy
      // `cancelFinetune(modelId)` paths both flow through the
      // registry.
      cancel: { scope: "model", hard: true },

      handler: function (request) {
        return finetune(request);
      },
    }),

    translate: defineHandler({
      requestSchema: translateRequestSchema,
      responseSchema: translateResponseSchema,
      streaming: true,
      cancel: { scope: "model", hard: true },

      handler: async function* (request) {
        const stream = translate(request, request.requestId);
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
          yield attachModelExecutionMs(
            {
              type: "translate" as const,
              token: "",
              done: true,
              ...(stats && { stats }),
            },
            modelExecutionMs,
          );
        } catch (err) {
          // Same addon, same overflow path as `completionStream`. Wrap so
          // translate consumers can `instanceof ContextOverflowError` too.
          if (isAddonContextOverflowError(err)) {
            const { promptTokens, ctxSize } = parseContextOverflowMessage(
              err instanceof Error ? err.message : "",
            );
            throw new ContextOverflowError(
              promptTokens,
              ctxSize,
              request.modelId,
              err,
            );
          }
          throw err;
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
