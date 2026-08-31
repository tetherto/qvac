import LlmLlamacpp from '@qvac/llm-llamacpp'
import llmAddonLogging from '@qvac/llm-llamacpp/addonLogging'
import {
  definePlugin,
  defineHandler,
  finetuneRequestSchema,
  batchCompletionStreamRequestSchema,
  batchCompletionStreamResponseSchema,
  completionStreamRequestSchema,
  completionStreamResponseSchema,
  finetuneResponseSchema,
  translateRequestSchema,
  translateResponseSchema,
  ModelType,
  llmConfigBaseSchema,
  ADDON_LLM,
  type BatchCompletionEvent,
  type CompletionEvent,
  type CreateModelParams,
  type PluginCapabilities,
  type PluginModelResult,
  type ResolveContext,
  type Tool,
  type ToolDialect,
  type LlmConfig,
  type LlmConfigInput
} from '@/schemas/index'
import { createStreamLogger, registerAddonLogger, getEngineLogger } from '@/logging/index'
import { getFirstShardPath } from '@/utils/index'
import { getModelParallel } from '@/utils/config-transform'
import { completion } from '@/plugins/builtin/llamacpp-completion/ops/completion-stream'
import { batchCompletion } from '@/plugins/builtin/llamacpp-completion/ops/batch-completion-stream'
import { finetune } from '@/plugins/builtin/llamacpp-completion/ops/finetune'
import { translate } from '@/plugins/ops/translate'
import { transformLlmConfig } from '@/plugins/builtin/llamacpp-completion/transform'
import { attachModelExecutionMs } from '@/profiling/model-execution'
import { getModelConfig } from '@/runtime/model-registry'
import { createCompletionNormalizer } from '@/utils/completion-normalizer'
import { detectToolDialect } from '@/utils/tool-integration'
import { getRequestRegistry, withRequestContext } from '@/runtime/index'
import { generateRandomRequestId } from '@/runtime/request-id'
import { ContextOverflowError } from '@/errors/index'
import {
  isAddonContextOverflowError,
  parseContextOverflowMessage
} from '@/plugins/builtin/llamacpp-completion/ops/context-overflow'
import { stoppedByLength } from '@/plugins/builtin/llamacpp-completion/ops/completion-stats'
import { isMobile } from '@/runtime/state'
import { stripMultiGpuKeys } from '@/utils/multi-gpu-mobile'

function createLlmModel(
  modelId: string,
  modelPath: string,
  llmConfig: LlmConfig,
  projectionModelPath?: string
) {
  const logger = createStreamLogger(modelId, ModelType.llamacppCompletion)
  registerAddonLogger(modelId, ModelType.llamacppCompletion, logger)
  const llmConfigStrings = transformLlmConfig(llmConfig)

  if (isMobile()) {
    const stripped = stripMultiGpuKeys(llmConfigStrings)
    if (stripped.length > 0) {
      getEngineLogger().warn(
        `[${ModelType.llamacppCompletion}:${modelId}] Multi-GPU parameters (${stripped.join(', ')}) are not supported on mobile (single-GPU device) — removing from config; model will load with single-GPU defaults`
      )
    }
  }

  // Addon overflow flag: at a single slot the addon throws when driven over
  // capacity, at parallel>1 it queues the surplus. Not on the SDK surface.
  const rejectWhenBusy = getModelParallel(llmConfig) <= 1

  const model = new LlmLlamacpp({
    files: {
      model: [getFirstShardPath(modelPath)],
      ...(projectionModelPath && { projectionModel: projectionModelPath })
    },
    config: llmConfigStrings,
    logger,
    opts: { stats: true, rejectWhenBusy }
  })

  return { model }
}

function wrapBatchEvents(id: string, events: CompletionEvent[]) {
  return events.map((event) => ({ id, event }))
}

function createBatchNormalizer(
  request: {
    captureThinking?: boolean | undefined
    emitRawDeltas?: boolean | undefined
    toolDialect?: ToolDialect | undefined
  },
  dialect: ToolDialect,
  tools: Tool[],
  toolsActive: boolean
) {
  const capabilities: PluginCapabilities = {
    toolCalling: toolsActive && tools.length > 0 ? 'textParse' : 'none',
    thinkingFraming: request.captureThinking ? 'thinkTags' : 'none'
  }

  return createCompletionNormalizer({
    capabilities,
    tools: toolsActive ? tools : [],
    captureThinking: request.captureThinking ?? false,
    emitRawDeltas: request.emitRawDeltas ?? false,
    toolDialect: request.toolDialect ?? dialect
  })
}

export const llmPlugin = definePlugin({
  modelType: ModelType.llamacppCompletion,
  displayName: 'LLM (llama.cpp)',
  addonPackage: ADDON_LLM,
  loadConfigSchema: llmConfigBaseSchema.strict(),

  async resolveConfig(cfg: LlmConfigInput, ctx: ResolveContext) {
    const { projectionModelSrc, ...llmConfig } = cfg

    if (!projectionModelSrc) {
      return { config: llmConfig }
    }

    const projectionModelPath = await ctx.resolveModelPath(projectionModelSrc)
    return {
      config: llmConfig,
      artifacts: { projectionModelPath }
    }
  },

  createModel(params: CreateModelParams): PluginModelResult {
    const llmConfig = (params.modelConfig ?? {}) as LlmConfig

    const { model } = createLlmModel(
      params.modelId,
      params.modelPath,
      llmConfig,
      params.artifacts?.['projectionModelPath']
    )

    return { model }
  },

  handlers: {
    batchCompletionStream: defineHandler({
      requestSchema: batchCompletionStreamRequestSchema,
      responseSchema: batchCompletionStreamResponseSchema,
      streaming: true,
      // Request-scope: a model-wide cancel would kill concurrent batching peers.
      cancel: { scope: 'request', hard: true },

      handler: async function* (request) {
        const dialect = request.toolDialect ?? detectToolDialect(request.modelId)
        const modelCfg = getModelConfig(request.modelId)
        const toolsActive = (modelCfg as { tools?: boolean }).tools === true
        const toolsByPosition = request.prompts.map((prompt) => prompt.tools ?? [])
        const toolsById = new Map<string, Tool[]>()
        const normalizers = new Map<string, ReturnType<typeof createCompletionNormalizer>>()
        const bufferedEvents: BatchCompletionEvent[] = []
        let ids: string[] = []

        function registerIds(addonIds: string[]) {
          ids = addonIds
          for (const [index, id] of addonIds.entries()) {
            toolsById.set(id, toolsByPosition[index] ?? [])
          }
        }

        function getNormalizer(id: string) {
          let normalizer = normalizers.get(id)
          if (!normalizer) {
            normalizer = createBatchNormalizer(
              request,
              dialect,
              toolsById.get(id) ?? [],
              toolsActive
            )
            normalizers.set(id, normalizer)
          }
          return normalizer
        }

        // Batches share the completion lane at the `parallel` cap. The cap counts
        // requests, not the prompts inside a batch (the addon schedules those).
        const parallel = getModelParallel(modelCfg as { parallel?: number })
        await using ctx = await getRequestRegistry().begin({
          requestId: request.requestId ?? generateRandomRequestId(),
          kind: 'batchCompletion',
          modelId: request.modelId,
          maxConcurrentPerModel: parallel
        })
        const requestLogger = withRequestContext(getEngineLogger(), ctx)

        // Boolean(...) keeps `ctx.signal.aborted` a boolean so the later
        // aborted checks aren't narrowed to false by this guard.
        const abortedBeforeRun = Boolean(ctx.signal.aborted)
        if (abortedBeforeRun) {
          const abortedIds = request.prompts.map((prompt, index) => prompt.id ?? String(index))
          yield {
            type: 'batchCompletionStream' as const,
            done: true,
            ids: abortedIds,
            events: abortedIds.flatMap((id) =>
              wrapBatchEvents(id, getNormalizer(id).finish({ stopReason: 'cancelled' as const }))
            )
          }
          return
        }

        const stream = batchCompletion(
          {
            modelId: request.modelId,
            prompts: request.prompts
          },
          { signal: ctx.signal, scope: ctx.scope, logger: requestLogger }
        )

        try {
          let result = await stream.next()

          while (!result.done) {
            if (result.value.type === 'ids') {
              registerIds(result.value.ids)
              yield {
                type: 'batchCompletionStream' as const,
                ids,
                events: []
              }
            } else {
              const { id, token } = result.value
              const events = wrapBatchEvents(id, getNormalizer(id).push(token))
              if (request.stream ?? true) {
                yield {
                  type: 'batchCompletionStream' as const,
                  events
                }
              } else {
                bufferedEvents.push(...events)
              }
            }
            result = await stream.next()
          }

          const { modelExecutionMs, stats, results } = result.value
          const terminalEvents: BatchCompletionEvent[] = []

          for (const batchResult of results) {
            const normalizer = getNormalizer(batchResult.id)
            if (normalizer.getAccumulated().rawText.length === 0 && batchResult.output.length > 0) {
              terminalEvents.push(
                ...wrapBatchEvents(batchResult.id, normalizer.push(batchResult.output))
              )
            }
            // Stats are batch-level (the addon reports one aggregate
            // snapshot, not per prompt), so they ride the top-level `stats`
            // field on the done frame below — NOT each prompt's terminal.
            terminalEvents.push(
              ...wrapBatchEvents(
                batchResult.id,
                normalizer.finish({
                  ...(ctx.signal.aborted && {
                    stopReason: 'cancelled' as const
                  })
                })
              )
            )
          }

          const finalEvents =
            (request.stream ?? true) ? terminalEvents : [...bufferedEvents, ...terminalEvents]

          yield attachModelExecutionMs(
            {
              type: 'batchCompletionStream' as const,
              done: true,
              ids,
              events: finalEvents,
              ...(stats && { stats })
            },
            modelExecutionMs
          )
        } catch (err) {
          if (isAddonContextOverflowError(err)) {
            const { promptTokens, ctxSize } = parseContextOverflowMessage(
              err instanceof Error ? err.message : ''
            )
            throw new ContextOverflowError(promptTokens, ctxSize, request.modelId, err)
          }
          // Once the registry accepts cancellation, the request signal owns the
          // terminal outcome. The addon may reject with different shapes
          // depending on whether native sequences were active or queued; those
          // transport details must not change the SDK cancellation contract.
          if (ctx.signal.aborted) {
            const cancelledIds =
              ids.length > 0
                ? ids
                : request.prompts.map((prompt, index) => prompt.id ?? String(index))
            const cancelledTerminals = cancelledIds.flatMap((id) =>
              wrapBatchEvents(id, getNormalizer(id).finish({ stopReason: 'cancelled' as const }))
            )
            yield {
              type: 'batchCompletionStream' as const,
              done: true,
              ids: cancelledIds,
              events:
                (request.stream ?? true)
                  ? cancelledTerminals
                  : [...bufferedEvents, ...cancelledTerminals]
            }
            return
          }
          throw err
        } finally {
          await stream.return?.(undefined as never)
        }
      }
    }),

    completionStream: defineHandler({
      requestSchema: completionStreamRequestSchema,
      responseSchema: completionStreamResponseSchema,
      streaming: true,
      // Request-scope: a model-wide cancel would kill concurrent batching peers.
      cancel: { scope: 'request', hard: true },

      handler: async function* (request) {
        const filteredHistory = request.history.map(({ role, content, attachments }) => ({
          role,
          content,
          attachments: attachments ?? []
        }))

        const modelCfg = getModelConfig(request.modelId)
        const toolsActive =
          (request.tools?.length ?? 0) > 0 && (modelCfg as { tools?: boolean }).tools === true

        const capabilities: PluginCapabilities = {
          toolCalling: toolsActive ? 'textParse' : 'none',
          thinkingFraming: request.captureThinking ? 'thinkTags' : 'none'
        }

        // Dialect runs regardless of tool availability — thinking/content
        // stripping is needed even on plain completions.
        const dialect = request.toolDialect ?? detectToolDialect(request.modelId)

        const normalizer = createCompletionNormalizer({
          capabilities,
          tools: request.tools ?? [],
          captureThinking: request.captureThinking ?? false,
          emitRawDeltas: request.emitRawDeltas ?? false,
          toolDialect: dialect
        })

        // Open a request-scoped lifecycle. The registry is the single
        // source of truth for "is this turn cancelled?" — we plumb the
        // signal into `completion()` and expose `requestId` so the
        // caller can target this run with `cancel({ requestId })`.
        // Falls back to a generated id if the caller didn't send one.
        // Admit up to `parallel` jobs. Disk-KV-cache turns share this lane too;
        // same-file writes serialise per cache path inside the KV-cache session.
        const parallel = getModelParallel(modelCfg as { parallel?: number })
        await using ctx = await getRequestRegistry().begin({
          requestId: request.requestId ?? generateRandomRequestId(),
          kind: 'completion',
          modelId: request.modelId,
          maxConcurrentPerModel: parallel
        })

        const requestLogger = withRequestContext(getEngineLogger(), ctx)

        // begin() can return already-aborted when the caller cancels while
        // this completion is queued behind another same-model one. It never
        // decoded, so it must not touch the shared native context — emit a
        // cancelled terminal and return. Boolean(...) keeps ctx.signal.aborted
        // a boolean so the mid-stream check below isn't narrowed to false.
        const abortedBeforeRun = Boolean(ctx.signal.aborted)
        if (abortedBeforeRun) {
          yield {
            type: 'completionStream' as const,
            done: true,
            events: normalizer.finish({ stopReason: 'cancelled' as const })
          }
          return
        }

        const stream = completion(
          {
            history: filteredHistory,
            modelId: request.modelId,
            kvCache: request.kvCache,
            ...(toolsActive && request.tools && { tools: request.tools }),
            ...(request.generationParams && { generationParams: request.generationParams }),
            ...(toolsActive && { toolDialect: dialect }),
            ...(request.responseFormat && { responseFormat: request.responseFormat })
          },
          { signal: ctx.signal, scope: ctx.scope, logger: requestLogger }
        )

        try {
          const batchedEvents: CompletionEvent[] = []
          let result = await stream.next()

          while (!result.done) {
            const events = normalizer.push(result.value.token)

            if (request.stream) {
              yield {
                type: 'completionStream' as const,
                events
              }
            } else {
              batchedEvents.push(...events)
            }
            result = await stream.next()
          }

          const { modelExecutionMs, stats, toolCalls, stoppedAtContextBoundary } = result.value
          // Cancellation rides the done path: observable via the last event's
          // stopReason; client aggregates reject with InferenceCancelledError.
          const cancelled = ctx.signal.aborted
          // EOS tokens are not decoded by llama_decode, so n_eval (and
          // therefore stats.generatedTokens) counts only real decode calls.
          // Positive prediction-budget exhaustion and a full context window
          // both map to stopReason "length"; cancellation takes precedence.
          const effectivePredict =
            request.generationParams?.predict ?? (modelCfg as LlmConfig).predict
          const lengthStop = stoppedByLength({
            cancelled,
            effectivePredict,
            generatedTokens: stats?.generatedTokens,
            stoppedAtContextBoundary
          })
          const terminalEvents = normalizer.finish({
            ...(stats && { stats }),
            ...(toolCalls.length > 0 && { toolCalls }),
            ...(cancelled && { stopReason: 'cancelled' as const }),
            ...(lengthStop && { stopReason: 'length' as const })
          })

          if (!request.stream) {
            batchedEvents.push(...terminalEvents)
          }

          const finalEvents = request.stream ? terminalEvents : batchedEvents

          yield attachModelExecutionMs(
            {
              type: 'completionStream' as const,
              done: true,
              events: finalEvents
            },
            modelExecutionMs
          )
        } catch (err) {
          // Classify a structured ContextOverflow first, even under an aborted
          // signal, so a real overflow racing a cancel surfaces as a typed
          // ContextOverflowError.

          if (isAddonContextOverflowError(err)) {
            const { promptTokens, ctxSize } = parseContextOverflowMessage(
              err instanceof Error ? err.message : ''
            )
            throw new ContextOverflowError(promptTokens, ctxSize, request.modelId, err)
          }
          // Context overflow is classified above. For every other error after
          // accepted cancellation, the request signal owns the terminal outcome
          // regardless of the addon's active/queued error shape.
          if (ctx.signal.aborted) {
            yield attachModelExecutionMs(
              {
                type: 'completionStream' as const,
                done: true,
                events: normalizer.finish({ stopReason: 'cancelled' as const })
              },
              // The error path has no model execution time to report; omit it
              // rather than claim 0.
              undefined
            )
            return
          }
          throw err
        } finally {
          await stream.return?.(undefined as never)
        }
      }
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
      cancel: { scope: 'model', hard: true },

      handler: function (request) {
        return finetune(request)
      }
    }),

    translate: defineHandler({
      requestSchema: translateRequestSchema,
      responseSchema: translateResponseSchema,
      streaming: true,
      // LLM translate cancels its own run (request-scoped), like completion.
      cancel: { scope: 'request', hard: true },

      handler: async function* (request) {
        const stream = translate(request, request.requestId)
        try {
          let result = await stream.next()

          while (!result.done) {
            yield {
              type: 'translate' as const,
              token: result.value
            }
            result = await stream.next()
          }

          const { modelExecutionMs, stats } = result.value
          yield attachModelExecutionMs(
            {
              type: 'translate' as const,
              token: '',
              done: true,
              ...(stats && { stats })
            },
            modelExecutionMs
          )
        } catch (err) {
          // Same addon, same overflow path as `completionStream`. Wrap so
          // translate consumers can `instanceof ContextOverflowError` too.
          if (isAddonContextOverflowError(err)) {
            const { promptTokens, ctxSize } = parseContextOverflowMessage(
              err instanceof Error ? err.message : ''
            )
            throw new ContextOverflowError(promptTokens, ctxSize, request.modelId, err)
          }
          throw err
        } finally {
          await stream.return?.(undefined as never)
        }
      }
    })
  },

  logging: {
    module: llmAddonLogging,
    namespace: ModelType.llamacppCompletion
  }
})
