import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, sendJson, sendError, initSSE, sendSSE, endSSE } from '../../../http.js'
import { resolveModelAlias } from '../../../config.js'
import { sdkCompletion, type CompletionResult } from '../../../core/sdk.js'
import type { SDKGenerationParams, SDKResponseFormat, SDKTool } from '../../../core/sdk.js'
import {
  extractResponsesGenerationParams,
  extractResponsesResponseFormat,
  historyPrefixFromStoredResponse,
  InvalidResponseFormatError,
  InvalidResponsesBackgroundError,
  InvalidResponsesConversationError,
  logResponsesUnsupportedParams,
  normalizeResponsesInputItemsForStorage,
  openaiResponsesInputToHistory,
  openaiResponsesToolsToSdk,
  sdkToolCallsToOpenai,
  UnsupportedToolTypeError,
  validateResponsesStatefulOptions
} from '../translate.js'
import { buildResponseObject, functionCallOutputItemId, messageId, responseId as allocResponseId } from '../responses-shape.js'
import { RESPONSES_DEFAULT_TTL_SEC, RESPONSES_VOLATILE_STUB, type StoredResponse } from '../responses-store.js'
import type { RouteContext } from '../../types.js'

function setVolatileHeader (res: ServerResponse): void {
  res.setHeader('X-QVAC-Stub', RESPONSES_VOLATILE_STUB)
}

export async function handlePostResponses (req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
  setVolatileHeader(res)

  let body: Record<string, unknown>
  try {
    body = await readBody(req)
  } catch {
    sendError(res, 400, 'invalid_json', 'Request body must be valid JSON.')
    return
  }

  let previousResponseId: string | undefined
  let storeEnabled: boolean
  try {
    ;({ previousResponseId, storeEnabled } = validateResponsesStatefulOptions(body))
  } catch (err) {
    if (err instanceof InvalidResponsesConversationError) {
      sendError(res, 400, 'conversation_not_supported', err.message)
      return
    }
    if (err instanceof InvalidResponsesBackgroundError) {
      sendError(res, 400, 'background_not_supported', err.message)
      return
    }
    throw err
  }

  if (!body['model']) {
    sendError(res, 400, 'missing_model', '"model" is required.')
    return
  }

  if (!('input' in body)) {
    sendError(res, 400, 'missing_input', '"input" is required.')
    return
  }

  const modelName = body['model'] as string
  const modelEntry = resolveModelAlias(ctx.serveConfig, modelName) ?? ctx.registry.getEntry(modelName)

  if (!modelEntry) {
    sendError(res, 404, 'model_not_found', `Model "${modelName}" is not available. Check serve.models config.`)
    return
  }

  const endpointCategory = 'endpointCategory' in modelEntry ? modelEntry.endpointCategory : undefined
  if (endpointCategory !== 'chat') {
    sendError(res, 400, 'invalid_model_type', `Model "${modelName}" does not support responses.`)
    return
  }

  const alias = 'alias' in modelEntry ? (modelEntry.alias as string) : modelEntry.id
  const registryEntry = ctx.registry.getEntry(alias)
  if (!registryEntry || registryEntry.state !== ctx.registry.STATES.READY) {
    sendError(res, 503, 'model_not_ready', `Model "${modelName}" is not loaded yet.`)
    return
  }

  logResponsesUnsupportedParams(body, ctx.logger)

  let tools: SDKTool[] | undefined
  try {
    tools = openaiResponsesToolsToSdk(body['tools'] as Parameters<typeof openaiResponsesToolsToSdk>[0])
  } catch (err) {
    if (err instanceof UnsupportedToolTypeError) {
      sendError(res, 400, 'invalid_tool_type', err.message)
      return
    }
    throw err
  }

  const generationParams = extractResponsesGenerationParams(body)

  let responseFormat: SDKResponseFormat | undefined
  try {
    responseFormat = extractResponsesResponseFormat(body)
  } catch (err) {
    if (err instanceof InvalidResponseFormatError) {
      sendError(res, 400, 'invalid_response_format', err.message)
      return
    }
    throw err
  }

  if (responseFormat && responseFormat.type !== 'text' && tools && tools.length > 0) {
    sendError(
      res,
      400,
      'invalid_response_format',
      'Structured output (json_object/json_schema) cannot be combined with "tools".'
    )
    return
  }

  const instructions = typeof body['instructions'] === 'string' ? body['instructions'] : undefined
  const inputItems = normalizeResponsesInputItemsForStorage(body['input'])

  let history = openaiResponsesInputToHistory(body['input'], instructions)
  if (previousResponseId) {
    const prev = ctx.responsesStore.get(previousResponseId)
    if (!prev) {
      sendError(res, 404, 'previous_response_not_found', `No response found for previous_response_id "${previousResponseId}".`)
      return
    }
    const prefix = historyPrefixFromStoredResponse(prev, (id) => ctx.responsesStore.get(id))
    history = [...prefix, ...history]
  }

  const sdkModelId = registryEntry.sdkModelId ?? registryEntry.id
  const modelAlias = alias
  const streaming = Boolean(body['stream'])
  const parallel = body['parallel_tool_calls']
  const parallelToolCalls = typeof parallel === 'boolean' ? parallel : true

  ctx.logger.info(
    `  responses model=${modelAlias} stream=${streaming}` +
    `${tools ? ` tools=${tools.length}` : ''}` +
    `${generationParams ? ` genParams=${JSON.stringify(generationParams)}` : ''}` +
    `${responseFormat ? ` responseFormat=${responseFormat.type}` : ''}` +
    `${previousResponseId ? ` prev=${previousResponseId}` : ''}`
  )

  const createdAtSec = Math.floor(Date.now() / 1000)
  const rid = allocResponseId()
  const meta = body['metadata']
  const metadata = meta !== undefined && meta !== null && typeof meta === 'object' && !Array.isArray(meta)
    ? meta as Record<string, unknown>
    : undefined

  const temperature = typeof body['temperature'] === 'number' ? body['temperature'] as number : undefined
  const topP = typeof body['top_p'] === 'number' ? body['top_p'] as number : undefined
  const maxOut = typeof body['max_output_tokens'] === 'number'
    ? body['max_output_tokens'] as number
    : (typeof body['max_tokens'] === 'number' ? body['max_tokens'] as number : undefined)

  const handlerParams: ResponsesHandlerParams = {
    ctx,
    sdkModelId,
    history,
    tools,
    generationParams,
    responseFormat,
    modelAlias,
    rid,
    createdAtSec,
    storeEnabled,
    inputItems,
    metadata,
    temperature,
    topP,
    maxOutputTokens: maxOut,
    parallelToolCalls,
    previousResponseId: previousResponseId ?? null
  }

  try {
    if (streaming) {
      const result = await sdkCompletion({
        modelId: handlerParams.sdkModelId,
        history: handlerParams.history,
        stream: true,
        tools: handlerParams.tools,
        generationParams: handlerParams.generationParams,
        responseFormat: handlerParams.responseFormat
      })
      await writeStreamingResponse(res, handlerParams, result)
    } else {
      const result = await sdkCompletion({
        modelId: handlerParams.sdkModelId,
        history: handlerParams.history,
        stream: false,
        tools: handlerParams.tools,
        generationParams: handlerParams.generationParams,
        responseFormat: handlerParams.responseFormat
      })
      await writeBlockingResponse(res, handlerParams, result)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.error(`Responses error for "${modelAlias}": ${message}`)
    sendError(res, 500, 'response_error', 'An internal error occurred during response generation.', { sseSentinel: false })
  }
}

export interface ResponsesHandlerParams {
  ctx: RouteContext
  sdkModelId: string
  history: Array<{ role: string; content: string }>
  tools?: SDKTool[] | undefined
  generationParams?: SDKGenerationParams | undefined
  responseFormat?: SDKResponseFormat | undefined
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
  result: CompletionResult
): Promise<Record<string, unknown>> {
  const text = await result.text
  const toolCalls = await result.toolCalls
  const stats = await result.stats

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

  sendJson(res, 200, responseObject)
  return responseObject
}

export async function writeStreamingResponse (
  res: ServerResponse,
  p: ResponsesHandlerParams,
  result: CompletionResult
): Promise<Record<string, unknown>> {
  initSSE(res)

  const msgId = messageId()
  let fullText = ''

  sendSSE(res, {
    type: 'response.created',
    response: { id: p.rid, object: 'response', created_at: p.createdAtSec, status: 'in_progress', model: p.modelAlias }
  })
  // Note: not emitting a duplicate `response.in_progress` event back-to-back with `response.created`
  // — the OpenAI stream only sends `response.in_progress` after a real state transition, and
  // emitting it here with identical payload is just noise for strict parsers.
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

  for await (const token of result.tokenStream) {
    fullText += token
    sendSSE(res, {
      type: 'response.output_text.delta',
      item_id: msgId,
      output_index: 0,
      content_index: 0,
      delta: token,
      response_id: p.rid
    })
  }

  const toolCalls = await result.toolCalls
  const hasToolCalls = toolCalls !== null && toolCalls !== undefined && toolCalls.length > 0

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
  const fcItemIds = hasToolCalls
    ? (openaiCalls ?? []).map(() => functionCallOutputItemId())
    : []

  if (hasToolCalls) {
    let i = 0
    for (const tc of openaiCalls ?? []) {
      const fcItemId = fcItemIds[i]!
      const outputIndex = i + 1
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

  const stats = await result.stats

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

  sendSSE(res, { type: 'response.completed', response: responseObject })
  // OpenAI Responses spec ends on `response.completed`; no `[DONE]` sentinel.
  endSSE(res, { sentinel: false })
  p.ctx.logger.info(`  responses stream done id=${p.rid} stored=${p.storeEnabled}`)
  return responseObject
}

export const META = {
  endpoints: ['POST /v1/responses'],
  caveats: [
    'in-memory store for retrieve/delete/input_items; not durable across restarts'
  ]
} as const
