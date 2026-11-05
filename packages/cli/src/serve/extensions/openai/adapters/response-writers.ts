import type { ServerResponse } from 'node:http'
import type { CompletionRun, Tool, ToolCall } from '@qvac/sdk'
import { sendSSE, endSSE } from '@/serve/lib/sse'
import { accumulateUsage, formatToolErrors } from '@/serve/core/completion'
import {
  drainCompletion,
  type DrainedOpenAICompletion
} from '@/serve/extensions/openai/adapters/completion-result'
import { sdkToolCallsToOpenai } from '@/serve/extensions/openai/adapters/tool-calls'
import {
  MAX_TOOL_SEARCH_ROUNDS,
  foldToolSearch,
  isInternalToolSearch,
  stripToolSearchCalls
} from '@/serve/lib/tool-search'
import type { GenerationParams, ResponseFormat } from '@/serve/extensions/openai/schemas/common'
import type {
  ResponsesHistoryItem,
  ToolNamespaces
} from '@/serve/extensions/openai/schemas/responses'
import {
  buildResponseObject,
  functionCallItem,
  clientToolName,
  functionCallOutputItemId,
  messageId,
  outputItem,
  reasoningItemId,
  type OutputSegment
} from '@/serve/extensions/openai/adapters/responses-shape'
import {
  RESPONSES_DEFAULT_TTL_SEC,
  RESPONSES_VOLATILE_STUB,
  type ResponsesStore,
  type StoredResponse
} from '@/serve/extensions/openai/adapters/responses-store'

interface ResponseWriterLogger {
  info: (message: string) => void
}

export interface ResponseWriterContext {
  logger: ResponseWriterLogger
  responsesStore: ResponsesStore
}

/**
 * Starts one generation over the given history. Each `tool_search` round calls
 * it again with the search results appended, so the caller owns per-turn setup
 * (cancellation binding in particular) rather than the writer.
 */
export type RunTurn = (history: ResponsesHistoryItem[]) => CompletionRun

export interface ResponsesHandlerParams {
  ctx: ResponseWriterContext
  sdkModelId: string
  history: ResponsesHistoryItem[]
  tools?: Tool[] | undefined
  toolNamespaces?: ToolNamespaces | undefined
  generationParams?: GenerationParams | undefined
  responseFormat?: ResponseFormat | undefined
  modelAlias: string
  rid: string
  createdAtSec: number
  storeEnabled: boolean
  inputItems: unknown[]
  metadata: Record<string, unknown> | undefined
  temperature: number | undefined
  topP: number | undefined
  maxOutputTokens: number | undefined
  parallelToolCalls: boolean
  previousResponseId: string | null
}

type SendEvent = (event: Record<string, unknown>) => void

interface OutputTimeline {
  text: (token: string) => void
  reasoning: (token: string) => void
  toolCall: (call: ToolCall) => void
  /** Ends a generation round; the next round's output starts new items. */
  endRound: () => void
  /** Closes the open item and returns every item; an empty turn gets an empty message. */
  finish: () => OutputSegment[]
}

type TextKind = 'message' | 'reasoning'

// Output items in the order the model produces them, function calls included.
// Each item finishes before the next starts, so text that follows reasoning or
// a call opens a new message item. Streaming passes `send` to emit the matching
// SSE events; blocking does not.
function createOutputTimeline(
  tools: Tool[] | undefined,
  namespaces: ToolNamespaces | undefined,
  send?: SendEvent
): OutputTimeline {
  type Open = Extract<OutputSegment, { type: TextKind }> & { outputIndex: number }
  let nextOutputIndex = 0
  let open: Open | undefined
  const items: OutputSegment[] = []

  function start(type: TextKind): Open {
    close()
    const item: Open = {
      type,
      id: type === 'message' ? messageId() : reasoningItemId(),
      text: '',
      outputIndex: nextOutputIndex++
    }
    open = item
    items.push(item)
    const part = type === 'message' ? 'output_text' : 'reasoning_text'
    send?.({
      type: 'response.output_item.added',
      output_index: item.outputIndex,
      item:
        type === 'message'
          ? { type: 'message', id: item.id, status: 'in_progress', role: 'assistant', content: [] }
          : { type: 'reasoning', id: item.id, status: 'in_progress', summary: [], content: [] }
    })
    send?.({
      type: 'response.content_part.added',
      item_id: item.id,
      output_index: item.outputIndex,
      content_index: 0,
      part: { type: part, text: '' }
    })
    return item
  }

  function close(): void {
    const item = open
    if (!item) return
    open = undefined
    const part = item.type === 'message' ? 'output_text' : 'reasoning_text'
    send?.({
      type: item.type === 'message' ? 'response.output_text.done' : 'response.reasoning_text.done',
      item_id: item.id,
      output_index: item.outputIndex,
      content_index: 0,
      text: item.text
    })
    send?.({
      type: 'response.content_part.done',
      item_id: item.id,
      output_index: item.outputIndex,
      content_index: 0,
      part: { type: part, text: item.text }
    })
    send?.({
      type: 'response.output_item.done',
      output_index: item.outputIndex,
      item: outputItem(item)
    })
  }

  function add(type: TextKind, token: string): void {
    const item = open?.type === type ? open : start(type)
    item.text += token
    send?.({
      type: type === 'message' ? 'response.output_text.delta' : 'response.reasoning_text.delta',
      item_id: item.id,
      output_index: item.outputIndex,
      content_index: 0,
      delta: token
    })
  }

  function toolCall(call: ToolCall): void {
    if (isInternalToolSearch(tools, call)) return
    close()
    const tc = sdkToolCallsToOpenai([call])![0]!
    const item = {
      type: 'function_call' as const,
      id: functionCallOutputItemId(),
      callId: tc.id,
      ...clientToolName(tc.function.name, namespaces),
      arguments: tc.function.arguments
    }
    const outputIndex = nextOutputIndex++
    items.push(item)
    send?.({
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: functionCallItem(item, 'in_progress')
    })
    send?.({
      type: 'response.function_call_arguments.delta',
      item_id: item.id,
      output_index: outputIndex,
      delta: item.arguments
    })
    send?.({
      type: 'response.function_call_arguments.done',
      item_id: item.id,
      output_index: outputIndex,
      arguments: item.arguments
    })
    send?.({ type: 'response.output_item.done', output_index: outputIndex, item: outputItem(item) })
  }

  return {
    text: (token) => add('message', token),
    reasoning: (token) => add('reasoning', token),
    toolCall,
    endRound: close,
    finish: () => {
      if (!items.some((item) => item.type !== 'reasoning')) start('message')
      close()
      return items.map((item) =>
        item.type === 'function_call' ? item : { type: item.type, id: item.id, text: item.text }
      )
    }
  }
}

function answerText(items: OutputSegment[]): string {
  return items.map((item) => (item.type === 'message' ? item.text : '')).join('')
}

export async function writeBlockingResponse(
  res: ServerResponse,
  p: ResponsesHandlerParams,
  runTurn: RunTurn
): Promise<Record<string, unknown>> {
  // `tool_search` is the SDK's own tool and no HTTP client has a handler for
  // it, so it is answered here and the model asked again. Requests with no
  // deferred tools leave the loop on the first pass.
  let turnHistory = p.history
  let drained
  let total: DrainedOpenAICompletion | undefined
  const timeline = createOutputTimeline(p.tools, p.toolNamespaces)
  for (let round = 0; ; round++) {
    if (round > 0) timeline.endRound()
    drained = await drainCompletion(
      runTurn(turnHistory),
      timeline.text,
      timeline.reasoning,
      timeline.toolCall
    )
    total = accumulateUsage(total, drained)
    if (round >= MAX_TOOL_SEARCH_ROUNDS) break
    const extended = foldToolSearch(
      p.tools,
      turnHistory,
      drained.toolCalls,
      drained.rawFullText ?? drained.text
    )
    if (!extended) break
    turnHistory = extended
  }
  const { toolCalls, toolErrors, stats, stopReason, completionTokens } = stripToolSearchCalls(
    p.tools,
    total ?? drained
  )
  const items = timeline.finish()

  const responseObject = buildResponseObject({
    id: p.rid,
    modelAlias: p.modelAlias,
    text: answerText(items),
    items,
    toolCalls,
    createdAtSec: p.createdAtSec,
    metadata: p.metadata,
    temperature: p.temperature,
    topP: p.topP,
    maxOutputTokens: p.maxOutputTokens,
    parallelToolCalls: p.parallelToolCalls,
    previousResponseId: p.previousResponseId,
    store: p.storeEnabled,
    ...(p.toolNamespaces !== undefined ? { toolNamespaces: p.toolNamespaces } : {}),
    completionTokens,
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(stats !== undefined ? { stats } : {})
  })

  if (p.storeEnabled) {
    const rec: StoredResponse = {
      id: p.rid,
      createdAtSec: p.createdAtSec,
      expiresAtSec: p.createdAtSec + RESPONSES_DEFAULT_TTL_SEC,
      responseObject,
      inputItems: p.inputItems,
      modelAlias: p.modelAlias
    }
    p.ctx.responsesStore.put(rec)
  }

  p.ctx.logger.info(
    `  responses done id=${p.rid} stored=${p.storeEnabled}${formatToolErrors(toolErrors)}`
  )

  if (!res.headersSent) {
    const payload = JSON.stringify(responseObject)
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-QVAC-Stub': RESPONSES_VOLATILE_STUB
    })
    res.end(payload)
  }
  return responseObject
}

// Every event of a Responses stream carries one increasing sequence number;
// kept per response so an error path outside the writer continues it.
const streamSequence = new WeakMap<ServerResponse, number>()

export function takeSequenceNumber(res: ServerResponse): number {
  const next = streamSequence.get(res) ?? 0
  streamSequence.set(res, next + 1)
  return next
}

export async function writeStreamingResponse(
  res: ServerResponse,
  p: ResponsesHandlerParams,
  runTurn: RunTurn
): Promise<Record<string, unknown>> {
  // Every event carries one increasing sequence number.
  const emit: SendEvent = (event) =>
    sendSSE(res, { ...event, sequence_number: takeSequenceNumber(res) })

  emit({
    type: 'response.created',
    response: {
      id: p.rid,
      object: 'response',
      created_at: p.createdAtSec,
      status: 'in_progress',
      model: p.modelAlias
    }
  })

  // Every turn streams live. Tool-call syntax is framed into `toolCall` events
  // by the normalizer, so a search turn emits no text deltas to withhold; what
  // it can emit is a preamble, which is fine to show. Only the SSE stream is
  // held open across a search round.
  const timeline = createOutputTimeline(p.tools, p.toolNamespaces, (event) =>
    emit({ ...event, response_id: p.rid })
  )

  let turnHistory = p.history
  let drained
  let total: DrainedOpenAICompletion | undefined
  for (let round = 0; ; round++) {
    // A search turn's preamble stays in the response object: it was streamed at
    // its own output_index, which must match its position in `output`.
    if (round > 0) timeline.endRound()
    drained = await drainCompletion(
      runTurn(turnHistory),
      timeline.text,
      timeline.reasoning,
      timeline.toolCall
    )
    total = accumulateUsage(total, drained)

    const extended =
      round >= MAX_TOOL_SEARCH_ROUNDS
        ? null
        : foldToolSearch(
            p.tools,
            turnHistory,
            drained.toolCalls,
            drained.rawFullText ?? drained.text
          )
    if (!extended) break
    // The search turn loaded definitions; ask again with them in the history.
    turnHistory = extended
  }

  const { toolCalls, toolErrors, stats, stopReason, completionTokens } = stripToolSearchCalls(
    p.tools,
    total ?? drained
  )
  const items = timeline.finish()

  const responseObject = buildResponseObject({
    id: p.rid,
    modelAlias: p.modelAlias,
    text: answerText(items),
    items,
    toolCalls,
    createdAtSec: p.createdAtSec,
    metadata: p.metadata,
    temperature: p.temperature,
    topP: p.topP,
    maxOutputTokens: p.maxOutputTokens,
    parallelToolCalls: p.parallelToolCalls,
    previousResponseId: p.previousResponseId,
    store: p.storeEnabled,
    ...(p.toolNamespaces !== undefined ? { toolNamespaces: p.toolNamespaces } : {}),
    completionTokens,
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(stats !== undefined ? { stats } : {})
  })

  if (p.storeEnabled) {
    const rec: StoredResponse = {
      id: p.rid,
      createdAtSec: p.createdAtSec,
      expiresAtSec: p.createdAtSec + RESPONSES_DEFAULT_TTL_SEC,
      responseObject,
      inputItems: p.inputItems,
      modelAlias: p.modelAlias
    }
    p.ctx.responsesStore.put(rec)
  }

  const terminalType =
    responseObject['status'] === 'incomplete' ? 'response.incomplete' : 'response.completed'
  emit({ type: terminalType, response: responseObject })
  endSSE(res, { sentinel: false })
  p.ctx.logger.info(
    `  responses stream done id=${p.rid} stored=${p.storeEnabled}${formatToolErrors(toolErrors)}`
  )
  return responseObject
}
