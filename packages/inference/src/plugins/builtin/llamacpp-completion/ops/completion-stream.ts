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
import {
  decideCachedHistorySlice,
  shouldCommitCachedTurn
} from '@/plugins/builtin/llamacpp-completion/ops/kv-cache-state'
import {
  createKvCacheSession,
  generateConfigHash,
  type KvCacheSession,
  type TurnHandle
} from '@/plugins/builtin/llamacpp-completion/ops/kv-cache-session'
import type { DisposableScope } from '@/runtime/disposable-scope'
import { detectToolDialect, prependToolsToHistory } from '@/utils/tool-integration'
import { parseToolCalls } from '@/utils/tools/index'
import { getResponseFormatJsonSchema } from '@/utils/response-format'
import { toolChoiceDemandsCall } from '@/schemas/completion-stream'
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
   * True if the model emitted at least one non-empty text token. Used by
   * `completion()` to decide whether to record a `savedCount` for the
   * kv-cache: a turn that produced nothing (legit early EOS or cancel
   * before any decode) must not leave a `history.length + 1` entry
   * behind, because that count will make the next turn slice its history
   * to an empty payload.
   */
  producedTokens: boolean
  /**
   * False only when the addon reports the `none` stop reason it gives a
   * cancelled run, which it rewinds to the pre-request state before saving.
   * Any other value, including a missing one, is treated as a finished run
   * whose output is in the cache file: the safe reading, since it costs a
   * re-prefill rather than a duplicated turn.
   */
  generationFinished: boolean
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

type HistoryMsg = {
  role: string
  content: string
  attachments?: { path: string }[] | undefined
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

/**
 * Attach the tool block to a turn payload, mirroring the no-kv-cache path
 * (`prependToolsToHistory`): after a system message when the payload carries
 * one, ahead of everything otherwise.
 */
function withToolBlock(messages: ChatHistory[], toolBlock: ChatHistory[]): ChatHistory[] {
  if (toolBlock.length === 0) return messages
  const systemIndex = messages.findIndex((msg) => msg.role === 'system')
  if (systemIndex === -1) return [...toolBlock, ...messages]
  return [...messages.slice(0, systemIndex + 1), ...toolBlock, ...messages.slice(systemIndex + 1)]
}

interface CachePayload {
  messages: ChatHistory[]
  /** Whether this payload carries the tool block. */
  toolBlockSent: boolean
  /**
   * Whether the block this payload carries is the complete tool set. A named
   * `tool_choice` makes the template render only that tool, so the copy it
   * writes into the cache must not be trusted as the full block.
   */
  toolBlockFull: boolean
  /** Whether the prefix already held a rendered block before this turn. */
  prefixHoldsBlock: boolean
  /**
   * Estimate of whether the prefix will hold a rendered tool block once this
   * turn commits. `resolveToolBlockCached` replaces it with the addon's own
   * report on the render when that report is available.
   */
  toolBlockCached: boolean
}

/**
 * Fallback guess for whether a payload carrying this tool block gets it in
 * front of the model, used only when the addon does not report
 * `toolDefinitionsDropped`. Qwen-family templates anchor their tool section on
 * the last user query and raise without one, and the addon answers that by
 * re-rendering with tools stripped, so require a user message before believing
 * the block landed.
 */
function rendersToolBlock(messages: HistoryMsg[], toolBlock: ChatHistory[]): boolean {
  if (toolBlock.length === 0) return false
  return messages.some((msg) => msg.role === 'user')
}

/**
 * Settle whether the committed prefix holds the full tool block. The addon's
 * `toolDefinitionsDropped` is the template's own word on whether the block it
 * was handed reached the model; without it (a payload with no block, or a
 * stand-in model) the payload's estimate stands.
 */
function resolveToolBlockCached(
  payload: CachePayload,
  stats: CompletionStats | undefined
): boolean {
  const dropped = stats?.toolDefinitionsDropped
  if (!payload.toolBlockSent || dropped === undefined) return payload.toolBlockCached
  return payload.prefixHoldsBlock || (payload.toolBlockFull && dropped === 0)
}

/**
 * Pick the messages that need to reach the model for the next turn.
 *
 * The cache holds whatever a committed turn sent, the tool block included, so
 * the block travels with a turn rather than being written into the prefix on
 * its own, and only with the turn that writes it into the cache — see
 * `skipToolBlock` below.
 */
async function prepareMessagesForCache(
  session: KvCacheSession,
  turn: TurnHandle,
  history: HistoryMsg[],
  tools?: Tool[],
  toolChoice?: string
): Promise<CachePayload> {
  const toolBlock = tools?.length ? transformMessages(tools) : []

  // Slice from the turn's `savedCount` so callers can
  // stage multiple messages between completions. `decideCachedHistorySlice`
  // also guards against the QVAC-17780 stale-count regression: if the
  // saved boundary would slice the history down to an empty payload
  // (e.g. after a cancelled mid-decode), it falls back to the full
  // history and signals the caller to drop the bad entry.
  // The session owns the entry; `dropStaleSavedCount` clears it in memory
  // and on disk without touching the cache file (the file is still
  // trustworthy — only the boundary count is wrong).
  const { messages, clearStaleCount } = decideCachedHistorySlice(turn.savedCount, history)

  if (clearStaleCount) {
    await session.dropStaleSavedCount(turn)
  }

  // The block is never trimmed back out of the cache, so re-sending it every
  // turn would leave one copy per turn and grow the prefix with the
  // conversation. Skip it only when the prefix is known to hold a rendered
  // one: `toolBlockCached` records that a previous turn actually got it into
  // the cache, which a committed message count does not prove. A stale
  // boundary means we are resending the whole conversation anyway.
  const prefixHoldsBlock = turn.toolBlockCached && !clearStaleCount
  // The addon arms the tool-call grammar only for a payload that carries
  // tools, and `required` / a named tool cannot be honoured without it. Such a
  // turn resends the block even into a prefix that holds one; the second copy
  // in the cache is the price of the guarantee.
  const demandsCall = toolChoiceDemandsCall(toolChoice) && toolBlock.length > 0
  const skipToolBlock = prefixHoldsBlock && !demandsCall
  const blockToSend = skipToolBlock ? [] : toolBlock
  const toolBlockFull = blockToSend.length > 0 && (!demandsCall || toolChoice === 'required')

  return {
    messages: withToolBlock(transformMessages(messages), blockToSend),
    toolBlockSent: blockToSend.length > 0,
    toolBlockFull,
    prefixHoldsBlock,
    toolBlockCached: prefixHoldsBlock || (toolBlockFull && rendersToolBlock(messages, blockToSend))
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
  onResponse?: (response: { cancel(): Promise<void> }) => void,
  onRunSettled?: () => void
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
  // The addon has finished, and saved the cache file if it was going to.
  onRunSettled?.()

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
    stoppedAtContextBoundary: stopReason === 'contextOverflow',
    generationFinished: stopReason !== 'none'
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
  const toolsActive = !!tools?.length && toolsEnabled
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

  // ---- KV-cache path. The session owns every bookkeeping layer; the handler
  // registers one deferred unwind that `commitTurn` short-circuits on the happy
  // path. It is the non-destructive `releaseTurn` when the committed file is
  // known to be intact — a throw before the addon run settled, or a cancel the
  // addon rewound — and the destructive `rollback` for everything else,
  // including zero-token replies, budget and context stops, and rename
  // failures. ----

  const session = createKvCacheSession(modelId, { logger: requestLogger })
  const systemPromptFromHistory = extractSystemPrompt(history)
  // The tool block is baked into the cache on the turn that first sends it and
  // never trimmed, so a late or changed tool set has to land on a fresh cache
  // rather than a warm prefix holding the old block.
  const configHash = generateConfigHash(systemPromptFromHistory, toolsActive ? tools : undefined)

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

  // Single cleanup hook for every non-success exit path. `commitTurn`
  // flips the turn's internal `committed` flag so this becomes a no-op
  // on the happy path. Scope unwinding is LIFO — registered after the
  // `removeEventListener` defer above so rollback runs before the
  // listener detach. `preserveCacheOnUnwind` selects the non-destructive
  // `releaseTurn` when the file on disk is known to still hold the last
  // committed turn; `releaseTurn` still drops a cache this turn created.
  let preserveCacheOnUnwind = false
  scope.defer(() => (preserveCacheOnUnwind ? session.releaseTurn(turn) : session.rollback(turn)))

  let payload: Awaited<ReturnType<typeof prepareMessagesForCache>>
  try {
    payload = await prepareMessagesForCache(
      session,
      turn,
      history,
      toolsActive ? tools : undefined,
      mergedGenerationParams?.tool_choice
    )
  } catch (error) {
    // A missing attachment is caller input rejected before the addon runs,
    // so the committed cache is untouched and must survive.
    preserveCacheOnUnwind = error instanceof AttachmentNotFoundError
    throw error
  }
  const messagesToSend = payload.messages
  logMessagesToAddon(messagesToSend, 'PROMPT_SEND')

  let result
  let addonRunSettled = false
  try {
    result = yield* processModelResponse(
      model,
      messagesToSend,
      tools,
      mergedGenerationParams,
      { cacheKey: turn.cachePath, saveCacheToDisk: true },
      dialect,
      setActiveResponse,
      () => {
        addonRunSettled = true
      }
    )
  } catch (error) {
    // The addon writes the cache file only after a run completes and skips the
    // save on every error path, so a run that threw left the committed file as
    // it was. An engine-side throw after the run settled is the opposite: the
    // file already holds this turn while no boundary was recorded for it.
    preserveCacheOnUnwind = !addonRunSettled
    throw error
  }
  const shouldCommitTurn = shouldCommitCachedTurn({
    aborted: signal.aborted,
    producedTokens: result.producedTokens,
    generatedTokens: result.stats?.generatedTokens,
    predict: mergedGenerationParams?.predict ?? (modelConfig as { predict?: number }).predict,
    stoppedAtContextBoundary: result.stoppedAtContextBoundary
  })
  // A cancelled run is rewound by the addon to the pre-request state before the
  // file is re-saved, so the committed cache is intact. Every other non-commit
  // finish (zero tokens, budget or context stop) was saved as-is and must go.
  // An abort that landed after the addon reported a stop reason is the latter.
  if (!shouldCommitTurn) {
    preserveCacheOnUnwind = signal.aborted && !result.generationFinished
  }

  if (typeof kvCache === 'string') {
    // Custom-key path: the addon wrote the new cache state inline at
    // the same path. Either commit (records the boundary, suppresses
    // rollback) or fall through to the deferred rollback.
    if (shouldCommitTurn) {
      await session.commitTurn(turn, {
        kind: 'static',
        messageCount: history.length + 1,
        toolBlockCached: resolveToolBlockCached(payload, result.stats)
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
  // we support auto-cache for structured assistant/tool turns,
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
    toolBlockCached: resolveToolBlockCached(payload, result.stats)
  })

  return result
}
