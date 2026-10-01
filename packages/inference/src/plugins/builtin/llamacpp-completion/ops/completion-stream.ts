import type { AbortSignal } from 'bare-abort-controller'
import type { RunOptions } from '@qvac/llm-llamacpp'
import type {
  CompletionParams,
  CompletionStats,
  GenerationParams,
  ResponseFormat,
  Tool,
  ToolCall,
  ToolDialect
} from '@/schemas/index'
import {
  logCacheDisabled,
  logCacheSave,
  logMessagesToAddon
} from '@/plugins/builtin/llamacpp-completion/ops/cache-logger'
import { extractSystemPrompt, getCurrentCacheInfo } from '@/plugins/ops/kv-cache-utils'
import { getModel, getModelConfig, type AnyModel } from '@/runtime/model-registry'
import { shouldCommitCachedTurn } from '@/plugins/builtin/llamacpp-completion/ops/kv-cache-state'
import {
  createKvCacheSession,
  generateConfigHash,
  type TurnHandle
} from '@/plugins/builtin/llamacpp-completion/ops/kv-cache-session'
import type { DisposableScope } from '@/runtime/disposable-scope'
import { detectToolDialect, prependToolsToHistory } from '@/utils/tool-integration'
import { resolveDeferredTools, toWireTool, withDeferredToolChoice } from '@/utils/tools/defer'
import { parseToolCalls } from '@/utils/tools/index'
import { getResponseFormatJsonSchema } from '@/utils/response-format'
import { buildAutoCacheSaveHistory, type CacheMessage } from '@/utils/index'
import { getEngineLogger } from '@/logging/index'
import type { Logger } from '@/logging/types'
import { AttachmentNotFoundError } from '@/errors/index'
import { nowMs } from '@/profiling/index'
import { buildStreamResult } from '@/profiling/model-execution'
import type { LlmStats } from '@/utils/addon-responses'
import {
  normalizeCompletionStats,
  withEmittedTokens
} from '@/plugins/builtin/llamacpp-completion/ops/completion-stats'
import fs from 'bare-fs'

const logger = getEngineLogger()

interface ResponseWithStats {
  stats?: LlmStats
}

interface CompletionResult {
  modelExecutionMs: number
  stats?: CompletionStats
  toolCalls: ToolCall[]
  stoppedAtContextBoundary: boolean
}

interface ProcessModelResponseResult extends CompletionResult {
  responseText: string
  /**
   * True if the model emitted at least one non-empty text token. An auto
   * cache is renamed to a key derived from the reply, so a turn that
   * produced nothing has no key to move to.
   */
  producedTokens: boolean
}

interface ChatHistory {
  role?: string
  content?: string
  type?: string
  name?: string
  description?: string
  parameters?: unknown
}

// Internal generation-params shape forwarded to the addon. Extends the
// public `GenerationParams` with `json_schema` (a JSON-Schema string the
// addon will convert to GBNF) so structured-output requests can constrain
// sampling per request without mutating the shared `modelConfig`. The
// addon types in `@qvac/llm-llamacpp@0.17.1`+ already include this field;
// the explicit `&` here keeps typing correct against `^0.16.0` until the
// dep bump propagates and is harmless once it has.
export type CompletionGenerationParams = GenerationParams & {
  json_schema?: string
}

type CompletionRunOptions = Pick<RunOptions, 'cacheKey' | 'saveCacheToDisk' | 'prefill'> & {
  generationParams?: CompletionGenerationParams
}

function transformMessage(
  message:
    | {
        role: string
        content: string
        attachments?: { path: string }[] | undefined
      }
    | Tool
): ChatHistory[] {
  const transformed: ChatHistory[] = []

  // Check if it's a tool definition (has type: "function")
  if ('type' in message && message.type === 'function') {
    transformed.push({
      type: 'function',
      name: message.name,
      description: message.description,
      parameters: message.parameters
    })
    return transformed
  }

  const msg = message as {
    role: string
    content: string
    attachments?: { path: string }[] | undefined
  }

  if (msg.attachments && msg.attachments.length > 0) {
    for (const attachment of msg.attachments) {
      if (!fs.existsSync(attachment.path)) {
        throw new AttachmentNotFoundError(attachment.path)
      }

      transformed.push({
        role: msg.role,
        content: attachment.path,
        type: 'media'
      })
    }
  }

  transformed.push({
    role: msg.role,
    content: msg.content
  })

  return transformed
}

function runModel(model: AnyModel, prompt: ChatHistory[], opts?: CompletionRunOptions) {
  return model.run(prompt, opts)
}

export function transformMessages(
  messages: Array<
    | {
        role: string
        content: string
        attachments?: { path: string }[] | undefined
      }
    | Tool
  >
): ChatHistory[] {
  const transformed: ChatHistory[] = []
  for (const message of messages) {
    transformed.push(...transformMessage(message))
  }
  return transformed
}

/**
 * Put the model's configured system prompt in front of a history that carries
 * none. `transform.ts` strips `system_prompt` from the config handed to the
 * addon, so the conversation is the only way it reaches the model.
 */
export function seedConfiguredSystemPrompt<T extends { role: string; content: string }>(
  history: T[],
  modelConfig: unknown
): T[] {
  const configured = (modelConfig as { system_prompt?: string }).system_prompt
  if (!configured || extractSystemPrompt(history) !== null) return history
  // Every caller's message type makes everything past role and content optional.
  return [{ role: 'system', content: configured } as T, ...history]
}

type CacheRunOptions = Pick<RunOptions, 'cacheKey' | 'saveCacheToDisk'>

async function* processModelResponse(
  model: AnyModel,
  messagesToSend: ChatHistory[],
  tools?: Tool[],
  generationParams?: CompletionGenerationParams,
  cacheOptions?: CacheRunOptions,
  dialect?: ToolDialect,
  onResponse?: (response: { cancel(): Promise<void> }) => void
): AsyncGenerator<{ token: string }, ProcessModelResponseResult, unknown> {
  const runOptions: CacheRunOptions & {
    generationParams?: CompletionGenerationParams
  } = {
    ...(generationParams && { generationParams }),
    ...(cacheOptions?.cacheKey !== undefined && {
      cacheKey: cacheOptions.cacheKey
    }),
    ...(cacheOptions?.saveCacheToDisk !== undefined && {
      saveCacheToDisk: cacheOptions.saveCacheToDisk
    })
  }
  const hasRunOptions = Object.keys(runOptions).length > 0

  const modelStart = nowMs()
  const response = await runModel(model, messagesToSend, hasRunOptions ? runOptions : undefined)
  // Hand the admitted response back so the caller can cancel just this job.
  onResponse?.(response)

  let accumulatedText = ''
  let producedTokens = false
  let emittedPieces = 0
  let toolCallsResult: ToolCall[] = []

  for await (const token of response.iterate()) {
    const tokenStr = token as string
    if (tokenStr.length > 0) {
      producedTokens = true
      emittedPieces++
    }
    accumulatedText += tokenStr
    yield { token: tokenStr }
  }
  const modelExecutionMs = nowMs() - modelStart

  if (cacheOptions?.saveCacheToDisk && cacheOptions.cacheKey) {
    logCacheSave(cacheOptions.cacheKey)
  }

  if (tools && tools.length > 0) {
    const { toolCalls } = parseToolCalls(accumulatedText, tools, dialect)
    toolCallsResult = toolCalls
  }

  const responseWithStats = response as unknown as ResponseWithStats
  const stats = withEmittedTokens(normalizeCompletionStats(responseWithStats.stats), emittedPieces)
  const stopReason = responseWithStats.stats?.stopReason

  return {
    ...buildStreamResult(modelExecutionMs, stats),
    toolCalls: toolCallsResult,
    responseText: accumulatedText,
    producedTokens,
    stoppedAtContextBoundary: stopReason === 'contextOverflow'
  }
}

export async function* completion(
  params: CompletionParams & {
    tools?: Tool[]
    generationParams?: GenerationParams
    toolDialect?: ToolDialect
    responseFormat?: ResponseFormat
  },
  opts: {
    signal: AbortSignal
    scope: DisposableScope
    /**
     * Request-scoped logger forwarded to `createKvCacheSession` so
     * kv-cache lines share the request's lifecycle prefix. Falls
     * back to the module-level server logger when omitted.
     */
    logger?: Logger
  }
): AsyncGenerator<{ token: string }, CompletionResult, unknown> {
  const {
    history: requestHistory,
    modelId,
    kvCache,
    tools,
    generationParams,
    responseFormat
  } = params
  const { signal, scope } = opts
  const requestLogger = opts.logger ?? logger

  const modelConfig = getModelConfig(modelId)
  const history = seedConfiguredSystemPrompt(requestHistory, modelConfig)
  const toolsEnabled = (modelConfig as { tools?: boolean }).tools === true
  // With deferred tools the prompt and the parser see different lists: the
  // prompt carries the always-loaded ones plus `tool_search` and its catalog,
  // while the parser also accepts whatever earlier searches appended to the
  // history. `null` when nothing defers, which leaves the existing path alone.
  const deferred = resolveDeferredTools(tools, history)
  const toolsToRender = deferred?.toolsToRender ?? tools?.map(toWireTool)
  const callableTools = deferred?.callableTools ?? toolsToRender
  const toolsActive = !!toolsToRender?.length && toolsEnabled
  const dialect =
    tools && tools.length > 0 ? (params.toolDialect ?? detectToolDialect(modelId)) : undefined

  // `responseFormat` is forwarded to the addon as a per-request
  // `generationParams.json_schema`, which the addon converts to GBNF and
  // applies for the duration of the request only. This avoids mutating
  // the shared `modelConfig` and is therefore safe under concurrent
  // completions on the same model. `tools` still constrain output through
  // their parameter schema and the dialect-specific parser chain (mutually
  // exclusive with a non-text `responseFormat` at the schema layer).
  let mergedGenerationParams: CompletionGenerationParams | undefined = generationParams
  if (responseFormat && !(tools && tools.length > 0)) {
    const jsonSchema = getResponseFormatJsonSchema(responseFormat)
    if (jsonSchema !== undefined) {
      mergedGenerationParams = {
        ...(generationParams ?? {}),
        json_schema: jsonSchema
      }
    }
  }
  mergedGenerationParams = withDeferredToolChoice(
    mergedGenerationParams,
    toolsActive ? deferred : null
  )

  const model = getModel(modelId)

  // Per-request hard cancel: under continuous batching the model runs several
  // jobs at once, so an abort must cancel only THIS request's job, not the
  // whole model — `response.cancel()` routes to the addon's per-job cancel.
  // `.catch(...)` keeps the fire-and-forget cancel from leaking a rejection.
  let activeResponse: { cancel(): Promise<void> } | null = null
  const cancelActive = () => {
    activeResponse?.cancel().catch((err: unknown) => {
      requestLogger.warn(
        `[cancel] response.cancel() rejected during abort for modelId=${modelId}: ${err instanceof Error ? err.message : String(err)}`
      )
    })
  }
  // Publish each run's response as it's admitted; the `signal.aborted` re-check
  // cancels it if the abort landed while run() was still being admitted.
  const setActiveResponse = (response: { cancel(): Promise<void> }) => {
    activeResponse = response
    if (signal.aborted) cancelActive()
  }
  const onAbort = () => cancelActive()
  signal.addEventListener('abort', onAbort, { once: true })
  // `{ once: true }` won't fire for an already-aborted signal (e.g. an
  // already-aborted parentSignal at begin), so fire once here; a no-op before
  // any response exists.
  if (signal.aborted) onAbort()

  scope.defer(() => {
    signal.removeEventListener('abort', onAbort)
    // Drop the ref so a late abort can't cancel an already-settled response.
    activeResponse = null
  })

  // The cached and uncached paths send the same prompt: the whole conversation
  // and the tools, every turn. With a cache key the addon keeps the longest
  // prefix it already holds and decodes only the rest.
  const prompt = transformMessages(
    toolsActive && toolsToRender ? prependToolsToHistory(history, toolsToRender) : history
  )

  if (!kvCache) {
    logCacheDisabled()
    logMessagesToAddon(prompt, 'NO_CACHE')
    return yield* processModelResponse(
      model,
      prompt,
      callableTools,
      mergedGenerationParams,
      undefined,
      dialect,
      setActiveResponse
    )
  }

  // ---- KV-cache path. The session owns every bookkeeping layer; the handler
  // registers one deferred unwind that `commitTurn` short-circuits. The addon
  // leaves the file consistent whatever the outcome — it commits or rewinds the
  // request itself — so the unwind keeps it (`releaseTurn`) except where the
  // file has no key to live under. ----

  const session = createKvCacheSession(modelId, { logger: requestLogger })
  const configHash = generateConfigHash(extractSystemPrompt(history))

  let turn: TurnHandle
  if (typeof kvCache === 'string') {
    turn = await session.beginTurn({
      kind: 'custom',
      customKey: kvCache,
      configHash,
      signal
    })
  } else {
    const cacheMessages: CacheMessage[] = history.map((msg) => ({
      role: msg.role,
      content: msg.content,
      attachments: msg.attachments ?? undefined
    }))
    turn = await session.beginTurn({
      kind: 'auto',
      configHash,
      history: cacheMessages,
      signal
    })
  }

  // Scope unwinding is LIFO — registered after the `removeEventListener`
  // defer above so this runs before the listener detach.
  let rollbackOnUnwind = false
  scope.defer(() => (rollbackOnUnwind ? session.rollback(turn) : session.releaseTurn(turn)))

  logMessagesToAddon(prompt, 'PROMPT_SEND')

  const result = yield* processModelResponse(
    model,
    prompt,
    callableTools,
    mergedGenerationParams,
    { cacheKey: turn.cachePath, saveCacheToDisk: true },
    dialect,
    setActiveResponse
  )

  if (typeof kvCache === 'string') {
    // Custom-key path: the addon saved whatever it kept, cancelled and
    // stopped turns included, at the same path.
    await session.commitTurn(turn, { kind: 'static' })
    return result
  }

  // Auto-cache path.
  //
  // Tool-call turns: the auto-cache key is derived from
  // `result.responseText`, which here is raw tool-call markup rather
  // than a clean assistant message. There's no safe post-response key
  // to rename to, so we let the deferred rollback drop the file. Once
  // we support auto-cache for structured assistant/tool turns,
  // this becomes a normal commit path.
  if (result.toolCalls.length > 0) {
    logger.warn(
      `[kv-cache] Auto cache tool-call turn; rolling back to avoid disk leak. path=${turn.cachePath}`
    )
    rollbackOnUnwind = true
    return result
  }

  const shouldRename = shouldCommitCachedTurn({
    aborted: signal.aborted,
    producedTokens: result.producedTokens,
    generatedTokens: result.stats?.generatedTokens,
    predict: mergedGenerationParams?.predict ?? (modelConfig as { predict?: number }).predict,
    stoppedAtContextBoundary: result.stoppedAtContextBoundary
  })
  if (!shouldRename) {
    // A cancelled, empty or cut-off reply is not one the caller will send
    // back as-is, so there is no post-response key to move to. The file stays
    // under the history it was found by.
    return result
  }

  const savedHistory = buildAutoCacheSaveHistory(
    history.map((msg) => ({
      role: msg.role,
      content: msg.content,
      attachments: msg.attachments ?? undefined
    })),
    result.responseText
  )
  const postResponseCacheInfo = await getCurrentCacheInfo(modelId, configHash, savedHistory)

  await session.commitTurn(turn, {
    kind: 'autoRename',
    targetCachePath: postResponseCacheInfo.cachePath
  })

  return result
}
