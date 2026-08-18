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
} from '@/schemas'
import {
  logCacheDisabled,
  logCacheInit,
  logCacheSave,
  logMessagesToAddon
} from '@/server/bare/plugins/llamacpp-completion/ops/cache-logger'
import { extractSystemPrompt, getCurrentCacheInfo } from '@/server/bare/ops/kv-cache-utils'
import { getModel, getModelConfig, type AnyModel } from '@/server/bare/registry/model-registry'
import {
  decideCachedHistorySlice,
  shouldCommitCachedTurn
} from '@/server/bare/plugins/llamacpp-completion/ops/kv-cache-state'
import {
  createKvCacheSession,
  generateConfigHash,
  type KvCacheSession,
  type TurnHandle
} from '@/server/bare/plugins/llamacpp-completion/ops/kv-cache-session'
import type { DisposableScope } from '@/server/bare/runtime/disposable-scope'
import { detectToolDialect, prependToolsToHistory } from '@/server/utils/tool-integration'
import { parseToolCalls } from '@/server/utils/tools'
import { getResponseFormatJsonSchema } from '@/server/utils/response-format'
import { buildAutoCacheSaveHistory, type CacheMessage } from '@/server/utils'
import { getServerLogger } from '@/logging'
import type { Logger } from '@/logging/types'
import { AttachmentNotFoundError } from '@/utils/errors-server'
import { nowMs } from '@/profiling'
import { buildStreamResult } from '@/profiling/model-execution'
import type { LlmStats } from '@/server/bare/types/addon-responses'
import {
  normalizeCompletionStats,
  withEmittedTokens
} from '@/server/bare/plugins/llamacpp-completion/ops/completion-stats'
import fs from 'bare-fs'

const logger = getServerLogger()

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
   * True if the model emitted at least one non-empty text token. Used by
   * `completion()` to decide whether to record a `savedCount` for the
   * kv-cache: a turn that produced nothing (legit early EOS or cancel
   * before any decode) must not leave a `history.length + 1` entry
   * behind, because that count will make the next turn slice its history
   * to an empty payload.
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
 * Prime the cache prefix with the system prompt only.
 *
 * Tools deliberately stay out of the prefix: a message list with no user turn
 * is not a renderable conversation for every chat template (Qwen3.5 raises
 * `No user query found in messages.` because it anchors its tool block on the
 * last user query), and a template failure degrades the whole render rather
 * than just the tool block. Tools travel with the turn instead.
 */
async function initSystemPromptCache(
  model: AnyModel,
  cachePathToUse: string,
  systemPromptToUse: string,
  cacheKey: string,
  onResponse?: (response: { cancel(): Promise<void> }) => void
) {
  const primeMessages: ChatHistory[] = [{ role: 'system', content: systemPromptToUse }]

  logCacheInit(cacheKey, systemPromptToUse)
  logMessagesToAddon(primeMessages, 'CACHE_INIT')

  const primeResponse = await runModel(model, primeMessages, {
    cacheKey: cachePathToUse,
    saveCacheToDisk: true,
    prefill: true
  })
  // Register the prime so an abort during a cold-cache prefill cancels it.
  onResponse?.(primeResponse)

  await primeResponse.await()
}

type HistoryMsg = {
  role: string
  content: string
  attachments?: { path: string }[] | undefined
}

/**
 * Attach the tool block ahead of a turn payload, mirroring the no-kv-cache
 * path (`prependToolsToHistory`).
 */
function withToolBlock(messages: ChatHistory[], toolBlock: ChatHistory[]): ChatHistory[] {
  if (toolBlock.length === 0) return messages
  return [...toolBlock, ...messages]
}

interface CachePayload {
  messages: ChatHistory[]
  /**
   * Whether the prefix will hold a rendered tool block once this turn
   * commits — either it already did, or this payload carries one the template
   * will render.
   */
  toolBlockCached: boolean
}

/**
 * Whether a payload carrying this tool block actually gets it in front of the
 * model. Qwen-family templates anchor their tool section on the last user
 * query and raise without one, and the addon answers that by re-rendering the
 * turn with tools stripped — a usable prompt with no tools in it. Recording
 * such a turn as "the block is cached now" would suppress the block for the
 * rest of the session, so require a user message before believing it landed.
 */
function rendersToolBlock(messages: HistoryMsg[], toolBlock: ChatHistory[]): boolean {
  if (toolBlock.length === 0) return false
  return messages.some((msg) => msg.role === 'user')
}

/**
 * Pick the messages that need to reach the model for the next turn.
 *
 * Tools are never baked into the primed prefix — a prefix with no user turn is
 * not a renderable conversation for every template — so they travel with a
 * turn instead.
 *
 *   - Empty history: nothing to slice; send whatever non-system messages
 *     exist. (The call site always reports the cache as existing, so this
 *     is the only way into this branch.)
 *   - Cache hit with a recorded `savedCount`: send only the unsaved tail
 *     (`history.slice(savedCount)`), so a multi-message turn (e.g. a
 *     consumer pushing both an assistant transcript and a follow-up user
 *     message between completions) all reaches the model.
 *   - Cache hit with a stale/missing `savedCount`: fall back to the full
 *     non-system history. The session is told (`dropStaleSavedCount`) so
 *     the bad boundary doesn't propagate into the next turn.
 *   - The tool block travels only with the turn that writes it into the
 *     cache; see `skipToolBlock` below.
 */
function prepareMessagesForCache(
  session: KvCacheSession,
  turn: TurnHandle,
  cacheExists: boolean,
  history: HistoryMsg[],
  tools?: Tool[],
  toolBlockEvictable = false
): CachePayload {
  const toolBlock = tools?.length ? transformMessages(tools) : []

  if (!(cacheExists && history.length > 0)) {
    const historyWithoutSystem = history.filter((msg) => msg.role !== 'system')
    return {
      messages: withToolBlock(transformMessages(historyWithoutSystem), toolBlock),
      toolBlockCached: rendersToolBlock(historyWithoutSystem, toolBlock)
    }
  }

  // Slice from the turn's `savedCount` so callers can
  // stage multiple messages between completions. `decideCachedHistorySlice`
  // also guards against the QVAC-17780 stale-count regression: if the
  // saved boundary would slice the history down to an empty payload
  // (e.g. after a cancelled mid-decode), it falls back to the full
  // non-system history and signals the caller to drop the bad entry.
  // The session owns the entry; `dropStaleSavedCount` clears it
  // without touching the on-disk file (the file is still trustworthy
  // — only the boundary count is wrong).
  const { messages, clearStaleCount } = decideCachedHistorySlice(
    turn.savedCount,
    cacheExists,
    history
  )

  if (clearStaleCount) {
    session.dropStaleSavedCount(turn)
  }

  // The block is never trimmed back out of the cache, so re-sending it every
  // turn would leave one copy per turn and grow the prefix with the
  // conversation. Skip it only when the prefix is known to hold a rendered
  // one: `toolBlockCached` records that a previous turn actually got it into
  // the cache, which a committed message count does not prove. A stale
  // boundary means we are resending the whole conversation anyway, and an
  // evictable block can no longer be assumed present.
  const skipToolBlock = turn.toolBlockCached && !clearStaleCount && !toolBlockEvictable
  const blockToSend = skipToolBlock ? [] : toolBlock

  return {
    messages: withToolBlock(transformMessages(messages), blockToSend),
    toolBlockCached: skipToolBlock || rendersToolBlock(messages, blockToSend)
  }
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

  return {
    ...buildStreamResult(modelExecutionMs, stats),
    toolCalls: toolCallsResult,
    responseText: accumulatedText,
    producedTokens,
    stoppedAtContextBoundary: responseWithStats.stats?.stopReason === 'contextOverflow'
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
  const { history, modelId, kvCache, tools, generationParams, responseFormat } = params
  const { signal, scope } = opts
  const requestLogger = opts.logger ?? logger

  const modelConfig = getModelConfig(modelId)
  const toolsEnabled = (modelConfig as { tools?: boolean }).tools === true
  const toolsActive = !!tools?.length && toolsEnabled
  // Sliding is opt-in (`n_discarded` defaults to 0). Once on, the addon's
  // discard window opens at the end of the primed prefix — which is where the
  // tool block sits, since the prime is the system prompt alone — and nothing
  // protects it. So while sliding is possible the block cannot be assumed to
  // survive, and it has to travel with every turn.
  const toolBlockEvictable = ((modelConfig as { n_discarded?: number }).n_discarded ?? 0) > 0

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

  if (!kvCache) {
    // KV-cache disabled — straight passthrough, no session involvement.
    let historyWithTools: Array<HistoryMsg | Tool> = history
    if (toolsActive && tools) {
      historyWithTools = prependToolsToHistory(history, tools)
    }

    const transformedHistory = transformMessages(historyWithTools)
    logCacheDisabled()
    logMessagesToAddon(transformedHistory, 'NO_CACHE')
    return yield* processModelResponse(
      model,
      transformedHistory,
      tools,
      mergedGenerationParams,
      undefined,
      dialect,
      setActiveResponse
    )
  }

  // ---- KV-cache path. The session owns all three bookkeeping layers
  // (on-disk `.bin`, `initializedCaches`, `cachedMessageCounts`). The
  // handler asks for a turn, registers rollback on the scope, and on
  // the happy path calls `commitTurn` which short-circuits the deferred
  // rollback. Cancellations / zero-token replies / rename failures all
  // unwind through the same `scope.defer` hook. ----

  const session = createKvCacheSession(modelId, { logger: requestLogger })
  const systemPromptFromHistory = extractSystemPrompt(history)
  // The tool block is baked into the cache on the turn that first sends it and
  // never trimmed, so a late or changed tool set has to land on a fresh cache
  // rather than a warm prefix holding the old block.
  const configHash = generateConfigHash(systemPromptFromHistory, toolsActive ? tools : undefined)

  const systemPromptToUse =
    systemPromptFromHistory ||
    (modelConfig as { system_prompt?: string }).system_prompt ||
    'You are a helpful assistant.'

  const primeIfMissing = async (cachePath: string) => {
    await initSystemPromptCache(
      model,
      cachePath,
      systemPromptToUse,
      typeof kvCache === 'string' ? kvCache : 'auto',
      setActiveResponse
    )
  }

  let turn: TurnHandle
  if (typeof kvCache === 'string') {
    turn = await session.beginTurn({
      kind: 'custom',
      customKey: kvCache,
      configHash,
      primeIfMissing,
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
      primeIfMissing,
      signal
    })
  }

  // Single cleanup hook for every non-success exit path. `commitTurn`
  // flips the turn's internal `committed` flag so this becomes a no-op
  // on the happy path. Scope unwinding is LIFO — registered after the
  // `removeEventListener` defer above so rollback runs before the
  // listener detach.
  scope.defer(() => session.rollback(turn))

  // `cacheExists` is implied by `beginTurn` — the session either found
  // an existing cache or just primed one. Pass `true` to the message
  // selector so the slicing branches engage.
  const payload = prepareMessagesForCache(
    session,
    turn,
    /* cacheExists */ true,
    history,
    toolsActive ? tools : undefined,
    toolBlockEvictable
  )
  const messagesToSend = payload.messages
  logMessagesToAddon(messagesToSend, 'PROMPT_SEND')

  const result = yield* processModelResponse(
    model,
    messagesToSend,
    tools,
    mergedGenerationParams,
    { cacheKey: turn.cachePath, saveCacheToDisk: true },
    dialect,
    setActiveResponse
  )
  const shouldCommitTurn = shouldCommitCachedTurn({
    aborted: signal.aborted,
    producedTokens: result.producedTokens,
    generatedTokens: result.stats?.generatedTokens,
    predict: mergedGenerationParams?.predict ?? (modelConfig as { predict?: number }).predict,
    stoppedAtContextBoundary: result.stoppedAtContextBoundary
  })

  if (typeof kvCache === 'string') {
    // Custom-key path: the addon wrote the new cache state inline at
    // the same path. Either commit (records the boundary, suppresses
    // rollback) or fall through to the deferred rollback.
    if (shouldCommitTurn) {
      await session.commitTurn(turn, {
        kind: 'static',
        messageCount: history.length + 1,
        toolBlockCached: payload.toolBlockCached
      })
    }
    return result
  }

  // Auto-cache path.
  //
  // Tool-call turns: the auto-cache key is derived from
  // `result.responseText`, which here is raw tool-call markup rather
  // than a clean assistant message. There's no safe post-response key
  // to rename to, so we let the deferred rollback drop the file. Once
  // the SDK supports auto-cache for structured assistant/tool turns,
  // this becomes a normal commit path.
  if (result.toolCalls.length > 0) {
    logger.warn(
      `[kv-cache] Auto cache tool-call turn; rolling back to avoid disk leak. path=${turn.cachePath}`
    )
    return result
  }

  if (!shouldCommitTurn) {
    // Cancelled, zero-token, or budget-exhausted turns do not establish
    // a trustworthy message boundary.
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
    targetCachePath: postResponseCacheInfo.cachePath,
    messageCount: savedHistory.length,
    toolBlockCached: payload.toolBlockCached
  })

  return result
}
