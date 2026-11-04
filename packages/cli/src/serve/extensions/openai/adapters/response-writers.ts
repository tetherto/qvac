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
  reasoningItem,
  reasoningItemId
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
  for (let round = 0; ; round++) {
    drained = await drainCompletion(runTurn(turnHistory))
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
  const { text, thinking, toolCalls, toolErrors, stats, stopReason, completionTokens } =
    stripToolSearchCalls(p.tools, total ?? drained)

  const responseObject = buildResponseObject({
    id: p.rid,
    modelAlias: p.modelAlias,
    text,
    ...(thinking ? { reasoning: thinking } : {}),
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
  const msgId = messageId()
  const rsId = reasoningItemId()
  let fullText = ''
  let reasoningText = ''
  let nextOutputIndex = 0
  let reasoningIndex: number | undefined
  let messageIndex: number | undefined
  let reasoningOpen = false

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

  // Items open in the order the model produces them: reasoning (if any), then
  // the message. Reasoning closes when the message opens.
  const closeReasoning = () => {
    if (!reasoningOpen) return
    reasoningOpen = false
    sendSSE(res, {
      type: 'response.reasoning_text.done',
      item_id: rsId,
      output_index: reasoningIndex,
      content_index: 0,
      text: reasoningText,
      response_id: p.rid
    })
    sendSSE(res, {
      type: 'response.content_part.done',
      item_id: rsId,
      output_index: reasoningIndex,
      content_index: 0,
      part: { type: 'reasoning_text', text: reasoningText },
      response_id: p.rid
    })
    sendSSE(res, {
      type: 'response.output_item.done',
      output_index: reasoningIndex,
      item: reasoningItem(rsId, reasoningText),
      response_id: p.rid
    })
  }

  const openMessage = (): number => {
    if (messageIndex !== undefined) return messageIndex
    closeReasoning()
    messageIndex = nextOutputIndex++
    sendSSE(res, {
      type: 'response.output_item.added',
      output_index: messageIndex,
      item: { type: 'message', id: msgId, status: 'in_progress', role: 'assistant', content: [] },
      sequence_number: 0,
      response_id: p.rid
    })
    sendSSE(res, {
      type: 'response.content_part.added',
      item_id: msgId,
      output_index: messageIndex,
      content_index: 0,
      part: { type: 'output_text', text: '' },
      response_id: p.rid
    })
    return messageIndex
  }

  // Every turn streams live. Tool-call syntax is framed into `toolCall` events
  // by the normalizer, so a search turn emits no text deltas to withhold; what
  // it can emit is a preamble, which is fine to show. Only the SSE stream is
  // held open across a search round.
  const sendDelta = (token: string) =>
    sendSSE(res, {
      type: 'response.output_text.delta',
      item_id: msgId,
      output_index: openMessage(),
      content_index: 0,
      delta: token,
      response_id: p.rid
    })

  const sendReasoningDelta = (token: string) => {
    // Reasoning after the message has opened has no item left to land in.
    if (messageIndex !== undefined) return
    if (reasoningIndex === undefined) {
      reasoningIndex = nextOutputIndex++
      reasoningOpen = true
      sendSSE(res, {
        type: 'response.output_item.added',
        output_index: reasoningIndex,
        item: { type: 'reasoning', id: rsId, status: 'in_progress', summary: [], content: [] },
        response_id: p.rid
      })
      sendSSE(res, {
        type: 'response.content_part.added',
        item_id: rsId,
        output_index: reasoningIndex,
        content_index: 0,
        part: { type: 'reasoning_text', text: '' },
        response_id: p.rid
      })
    }
    reasoningText += token
    sendSSE(res, {
      type: 'response.reasoning_text.delta',
      item_id: rsId,
      output_index: reasoningIndex,
      content_index: 0,
      delta: token,
      response_id: p.rid
    })
  }

  let turnHistory = p.history
  let drained
  let total: DrainedOpenAICompletion | undefined
  for (let round = 0; ; round++) {
    // Only the answering turn's text belongs in the final response object; a
    // search turn's preamble was streamed but is not part of the answer.
    fullText = ''
    drained = await drainCompletion(
      runTurn(turnHistory),
      (token) => {
        fullText += token
        sendDelta(token)
      },
      sendReasoningDelta
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
  const hasToolCalls = toolCalls.length > 0
  const msgIndex = openMessage()

  sendSSE(res, {
    type: 'response.output_text.done',
    item_id: msgId,
    output_index: msgIndex,
    content_index: 0,
    text: fullText,
    response_id: p.rid
  })
  sendSSE(res, {
    type: 'response.content_part.done',
    item_id: msgId,
    output_index: msgIndex,
    content_index: 0,
    response_id: p.rid
  })
  sendSSE(res, {
    type: 'response.output_item.done',
    output_index: msgIndex,
    item: {
      type: 'message',
      id: msgId,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: fullText, annotations: [] }]
    },
    response_id: p.rid
  })

  const openaiCalls = sdkToolCallsToOpenai(toolCalls)
  const fcItemIds = hasToolCalls ? (openaiCalls ?? []).map(() => functionCallOutputItemId()) : []

  if (hasToolCalls) {
    let i = 0
    for (const tc of openaiCalls ?? []) {
      const fcItemId = fcItemIds[i]!
      const outputIndex = msgIndex + 1 + i
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
    text: fullText,
    ...(reasoningText ? { reasoning: reasoningText, reasoningItemId: rsId } : {}),
    toolCalls,
    createdAtSec: p.createdAtSec,
    metadata: p.metadata,
    temperature: p.temperature,
    topP: p.topP,
    maxOutputTokens: p.maxOutputTokens,
    parallelToolCalls: p.parallelToolCalls,
    previousResponseId: p.previousResponseId,
    store: p.storeEnabled,
    messageItemId: msgId,
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
