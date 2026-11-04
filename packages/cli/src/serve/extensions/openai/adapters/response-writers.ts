import type { ServerResponse } from 'node:http'
import type { CompletionRun, Tool } from '@qvac/sdk'
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
  stripToolSearchCalls
} from '@/serve/lib/tool-search'
import type { GenerationParams, ResponseFormat } from '@/serve/extensions/openai/schemas/common'
import type { ResponsesHistoryItem } from '@/serve/extensions/openai/schemas/responses'
import {
  buildResponseObject,
  functionCallOutputItemId,
  messageId,
  messageItem,
  reasoningItem,
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
  /** Drops the items so far from the answer; a `tool_search` round streamed them. */
  newTurn: () => void
  /** Closes the open item and returns the answer's items, always with a message. */
  finish: () => { items: OutputSegment[]; nextOutputIndex: number }
}

// Output items in the order the model produces them. Each item finishes before
// the next starts, so text that follows reasoning opens a new message item.
// Streaming passes `send` to emit the matching SSE events; blocking does not.
function createOutputTimeline(send?: SendEvent): OutputTimeline {
  type Open = OutputSegment & { outputIndex: number }
  let nextOutputIndex = 0
  let open: Open | undefined
  let turn: Open[] = []

  function start(type: OutputSegment['type']): Open {
    const item: Open = {
      type,
      id: type === 'message' ? messageId() : reasoningItemId(),
      text: '',
      outputIndex: nextOutputIndex++
    }
    open = item
    turn.push(item)
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
      item:
        item.type === 'message'
          ? messageItem(item.id, item.text)
          : reasoningItem(item.id, item.text)
    })
  }

  function add(type: OutputSegment['type'], token: string): void {
    let item = open
    if (item?.type !== type) {
      close()
      item = start(type)
    }
    item.text += token
    send?.({
      type: type === 'message' ? 'response.output_text.delta' : 'response.reasoning_text.delta',
      item_id: item.id,
      output_index: item.outputIndex,
      content_index: 0,
      delta: token
    })
  }

  return {
    text: (token) => add('message', token),
    reasoning: (token) => add('reasoning', token),
    newTurn: () => {
      close()
      turn = []
    },
    finish: () => {
      if (!turn.some((item) => item.type === 'message')) start('message')
      close()
      return {
        items: turn.map(({ type, id, text }) => ({ type, id, text })),
        nextOutputIndex
      }
    }
  }
}

function answerText(items: OutputSegment[]): string {
  return items
    .filter((item) => item.type === 'message')
    .map((item) => item.text)
    .join('')
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
  const timeline = createOutputTimeline()
  for (let round = 0; ; round++) {
    // As in streaming, only the answering turn's items belong in the response.
    if (round > 0) timeline.newTurn()
    drained = await drainCompletion(runTurn(turnHistory), timeline.text, timeline.reasoning)
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
  const { items } = timeline.finish()

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

export async function writeStreamingResponse(
  res: ServerResponse,
  p: ResponsesHandlerParams,
  runTurn: RunTurn
): Promise<Record<string, unknown>> {
  sendSSE(res, {
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
  const timeline = createOutputTimeline((event) => sendSSE(res, { ...event, response_id: p.rid }))

  let turnHistory = p.history
  let drained
  let total: DrainedOpenAICompletion | undefined
  for (let round = 0; ; round++) {
    // Only the answering turn's items belong in the final response object; a
    // search turn's preamble was streamed but is not part of the answer.
    if (round > 0) timeline.newTurn()
    drained = await drainCompletion(runTurn(turnHistory), timeline.text, timeline.reasoning)
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
  const hasToolCalls = toolCalls.length > 0
  const { items, nextOutputIndex: firstCallIndex } = timeline.finish()

  const openaiCalls = sdkToolCallsToOpenai(toolCalls)
  const fcItemIds = hasToolCalls ? (openaiCalls ?? []).map(() => functionCallOutputItemId()) : []

  if (hasToolCalls) {
    let i = 0
    for (const tc of openaiCalls ?? []) {
      const fcItemId = fcItemIds[i]!
      const outputIndex = firstCallIndex + i
      const argsStr = tc.function.arguments
      sendSSE(res, {
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: {
          type: 'function_call',
          id: fcItemId,
          call_id: tc.id,
          name: tc.function.name,
          arguments: '',
          status: 'in_progress'
        },
        response_id: p.rid
      })
      sendSSE(res, {
        type: 'response.function_call_arguments.delta',
        item_id: fcItemId,
        output_index: outputIndex,
        delta: argsStr,
        response_id: p.rid
      })
      sendSSE(res, {
        type: 'response.function_call_arguments.done',
        item_id: fcItemId,
        output_index: outputIndex,
        arguments: argsStr,
        response_id: p.rid
      })
      sendSSE(res, {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item: {
          type: 'function_call',
          id: fcItemId,
          call_id: tc.id,
          name: tc.function.name,
          arguments: argsStr,
          status: 'completed'
        },
        response_id: p.rid
      })
      i++
    }
  }

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
    completionTokens,
    ...(hasToolCalls ? { functionCallItemIds: fcItemIds } : {}),
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
  sendSSE(res, { type: terminalType, response: responseObject })
  endSSE(res, { sentinel: false })
  p.ctx.logger.info(
    `  responses stream done id=${p.rid} stored=${p.storeEnabled}${formatToolErrors(toolErrors)}`
  )
  return responseObject
}
