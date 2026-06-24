import type { ServerResponse } from 'node:http'
import type { CompletionRun, Tool } from '@qvac/sdk'
import { sendSSE, endSSE } from '../../lib/sse.js'
import { drainCompletion } from './completion-result.js'
import { sdkToolCallsToOpenai } from './tool-calls.js'
import type { GenerationParams, ResponseFormat } from '../../schemas/common.js'
import { buildResponseObject, functionCallOutputItemId, messageId } from './responses-shape.js'
import { RESPONSES_DEFAULT_TTL_SEC, RESPONSES_VOLATILE_STUB, type ResponsesStore, type StoredResponse } from './responses-store.js'

interface ResponseWriterLogger {
  info: (message: string) => void
}

export interface ResponseWriterContext {
  logger: ResponseWriterLogger
  responsesStore: ResponsesStore
}

export interface ResponsesHandlerParams {
  ctx: ResponseWriterContext
  sdkModelId: string
  history: Array<{ role: string; content: string }>
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

export async function writeBlockingResponse (
  res: ServerResponse,
  p: ResponsesHandlerParams,
  result: CompletionRun
): Promise<Record<string, unknown>> {
  const { text, toolCalls, stats, stopReason } = await drainCompletion(result)

  const responseObject = buildResponseObject({
    id: p.rid,
    modelAlias: p.modelAlias,
    text,
    toolCalls,
    createdAtSec: p.createdAtSec,
    metadata: p.metadata,
    temperature: p.temperature,
    topP: p.topP,
    maxOutputTokens: p.maxOutputTokens,
    parallelToolCalls: p.parallelToolCalls,
    previousResponseId: p.previousResponseId,
    store: p.storeEnabled,
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

  p.ctx.logger.info(`  responses done id=${p.rid} stored=${p.storeEnabled}`)

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

export async function writeStreamingResponse (
  res: ServerResponse,
  p: ResponsesHandlerParams,
  result: CompletionRun
): Promise<Record<string, unknown>> {
  const msgId = messageId()
  let fullText = ''

  sendSSE(res, {
    type: 'response.created',
    response: { id: p.rid, object: 'response', created_at: p.createdAtSec, status: 'in_progress', model: p.modelAlias }
  })
  sendSSE(res, {
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'message', id: msgId, status: 'in_progress', role: 'assistant', content: [] },
    sequence_number: 0,
    response_id: p.rid
  })
  sendSSE(res, {
    type: 'response.content_part.added',
    item_id: msgId,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '' },
    response_id: p.rid
  })

  const { toolCalls, stats, stopReason } = await drainCompletion(result, (token) => {
    fullText += token
    sendSSE(res, {
      type: 'response.output_text.delta',
      item_id: msgId,
      output_index: 0,
      content_index: 0,
      delta: token,
      response_id: p.rid
    })
  })
  const hasToolCalls = toolCalls.length > 0

  sendSSE(res, {
    type: 'response.output_text.done',
    item_id: msgId,
    output_index: 0,
    content_index: 0,
    text: fullText,
    response_id: p.rid
  })
  sendSSE(res, {
    type: 'response.content_part.done',
    item_id: msgId,
    output_index: 0,
    content_index: 0,
    response_id: p.rid
  })
  sendSSE(res, {
    type: 'response.output_item.done',
    output_index: 0,
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
      const outputIndex = i + 1
      const argsStr = tc.function.arguments
      sendSSE(res, {
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: { type: 'function_call', id: fcItemId, call_id: tc.id, name: tc.function.name, arguments: '', status: 'in_progress' },
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
        item: { type: 'function_call', id: fcItemId, call_id: tc.id, name: tc.function.name, arguments: argsStr, status: 'completed' },
        response_id: p.rid
      })
      i++
    }
  }

  const responseObject = buildResponseObject({
    id: p.rid,
    modelAlias: p.modelAlias,
    text: fullText,
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

  const terminalType = responseObject['status'] === 'incomplete' ? 'response.incomplete' : 'response.completed'
  sendSSE(res, { type: terminalType, response: responseObject })
  endSSE(res, { sentinel: false })
  p.ctx.logger.info(`  responses stream done id=${p.rid} stored=${p.storeEnabled}`)
  return responseObject
}
