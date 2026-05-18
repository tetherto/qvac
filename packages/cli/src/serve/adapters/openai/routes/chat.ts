import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, sendJson, sendError, initSSE, sendSSE, endSSE } from '../../../http.js'
import { resolveModelAlias } from '../../../config.js'
import { sdkCompletion } from '../../../core/sdk.js'
import type { SDKTool, SDKGenerationParams, SDKResponseFormat } from '../../../core/sdk.js'
import { bindClientDisconnectCancel } from '../../../core/cancel-bridge.js'
import {
  openaiMessagesToHistory,
  openaiToolsToSdk,
  sdkToolCallsToOpenai,
  sdkToolCallsToOpenaiDeltas,
  extractGenerationParams,
  extractResponseFormat,
  InvalidResponseFormatError,
  logUnsupportedParams
} from '../translate.js'
import type { RouteContext } from '../../types.js'

export async function handleChatCompletions (req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
  let body: Record<string, unknown>
  try {
    body = await readBody(req)
  } catch {
    sendError(res, 400, 'invalid_json', 'Request body must be valid JSON.')
    return
  }

  if (!body['model']) {
    sendError(res, 400, 'missing_model', '"model" is required.')
    return
  }

  if (!body['messages'] || !Array.isArray(body['messages'])) {
    sendError(res, 400, 'missing_messages', '"messages" must be an array.')
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
    sendError(res, 400, 'invalid_model_type', `Model "${modelName}" does not support chat completions.`)
    return
  }

  const alias = 'alias' in modelEntry ? (modelEntry.alias as string) : modelEntry.id
  const registryEntry = ctx.registry.getEntry(alias)
  if (!registryEntry || registryEntry.state !== ctx.registry.STATES.READY) {
    sendError(res, 503, 'model_not_ready', `Model "${modelName}" is not loaded yet.`)
    return
  }

  logUnsupportedParams(body, ctx.logger)

  const sdkModelId = registryEntry.sdkModelId ?? registryEntry.id
  const history = openaiMessagesToHistory(body['messages'] as Array<{
    role: string
    content: string | null | undefined
    tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
    tool_call_id?: string
  }>)
  const tools = openaiToolsToSdk(body['tools'] as Array<{ type: string; function?: { name: string; description?: string; parameters?: Record<string, unknown> } }> | undefined)
  const generationParams = extractGenerationParams(body)

  let responseFormat: SDKResponseFormat | undefined
  try {
    responseFormat = extractResponseFormat(body)
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
      '"response_format" (json_object/json_schema) cannot be combined with "tools".'
    )
    return
  }

  const modelAlias = alias
  const streaming = Boolean(body['stream'])
  const msgCount = (body['messages'] as unknown[]).length

  ctx.logger.info(`  chat model=${modelAlias} messages=${msgCount} stream=${streaming}${tools ? ` tools=${tools.length}` : ''}${generationParams ? ` genParams=${JSON.stringify(generationParams)}` : ''}${responseFormat ? ` responseFormat=${responseFormat.type}` : ''}`)

  try {
    if (streaming) {
      await handleStreamingCompletion(req, res, { sdkModelId, history, tools, generationParams, responseFormat, modelAlias, logger: ctx.logger })
    } else {
      await handleBlockingCompletion(req, res, { sdkModelId, history, tools, generationParams, responseFormat, modelAlias, logger: ctx.logger })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.error(`Completion error for "${modelAlias}": ${message}`)
    sendError(res, 500, 'completion_error', 'An internal error occurred during completion.')
  }
}

interface CompletionParams {
  sdkModelId: string
  history: Array<{ role: string; content: string }>
  tools?: SDKTool[] | undefined
  generationParams?: SDKGenerationParams | undefined
  responseFormat?: SDKResponseFormat | undefined
  modelAlias: string
  logger: import('../../../../logger.js').Logger
}

function completionTokensFromStats (text: string, stats: { generatedTokens?: number } | undefined): number {
  if (typeof stats?.generatedTokens === 'number' && Number.isFinite(stats.generatedTokens)) {
    return stats.generatedTokens
  }
  return text ? text.split(/\s+/).filter(Boolean).length : 0
}

async function handleBlockingCompletion (req: IncomingMessage, res: ServerResponse, params: CompletionParams): Promise<void> {
  const result = await sdkCompletion({
    modelId: params.sdkModelId,
    history: params.history,
    stream: false,
    tools: params.tools,
    generationParams: params.generationParams,
    responseFormat: params.responseFormat
  })

  // Bridge HTTP client disconnect → SDK cancel. Bound after the
  // wrapper await but before any `await` on the result aggregates,
  // so a fetch-abort mid-completion lands on the in-flight requestId
  // before tokens have fully resolved.
  bindClientDisconnectCancel(req, res, result.requestId, params.logger)

  const text = await result.text
  const toolCalls = await result.toolCalls
  const stats = await result.stats

  const hasToolCalls = toolCalls !== null && toolCalls !== undefined && toolCalls.length > 0
  const finishReason = hasToolCalls ? 'tool_calls' : 'stop'

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: hasToolCalls ? null : (text || null)
  }
  if (hasToolCalls) {
    message['tool_calls'] = sdkToolCallsToOpenai(toolCalls)
  }

  const completionTokens = completionTokensFromStats(text || '', stats)

  params.logger.info(`  completion done tokens=${completionTokens} finish=${finishReason}`)

  sendJson(res, 200, {
    id: `chatcmpl-${randomId()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: params.modelAlias,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: completionTokens,
      total_tokens: completionTokens
    }
  })
}

async function handleStreamingCompletion (req: IncomingMessage, res: ServerResponse, params: CompletionParams): Promise<void> {
  const result = await sdkCompletion({
    modelId: params.sdkModelId,
    history: params.history,
    stream: true,
    tools: params.tools,
    generationParams: params.generationParams,
    responseFormat: params.responseFormat
  })

  // Bridge HTTP client disconnect → SDK cancel. The synchronous
  // `result.requestId` (decorated on the `CompletionRun`) is what makes
  // this work: we can bind the listener before the first SSE frame
  // streams, so a fetch-abort during inference aborts the in-flight
  // SDK request rather than letting it run to natural completion.
  bindClientDisconnectCancel(req, res, result.requestId, params.logger)

  initSSE(res)

  const id = `chatcmpl-${randomId()}`
  const created = Math.floor(Date.now() / 1000)

  const chunk = (delta: Record<string, unknown>, finishReason: string | null, extra?: Record<string, unknown>) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: params.modelAlias,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra
  })

  sendSSE(res, chunk({ role: 'assistant', content: '' }, null))

  for await (const token of result.tokenStream) {
    sendSSE(res, chunk({ content: token }, null))
  }

  const toolCalls = await result.toolCalls
  const hasToolCalls = toolCalls !== null && toolCalls !== undefined && toolCalls.length > 0

  const stats = await result.stats
  const fullText = await result.text
  const completionTokens = completionTokensFromStats(fullText || '', stats)

  params.logger.info(`  streaming done tokens=${completionTokens}`)

  if (hasToolCalls) {
    const openaiToolCalls = sdkToolCallsToOpenaiDeltas(toolCalls)
    sendSSE(res, chunk({ tool_calls: openaiToolCalls }, null))
    sendSSE(res, chunk({}, 'tool_calls'))
  } else {
    sendSSE(res, chunk({}, 'stop', {
      usage: { prompt_tokens: 0, completion_tokens: completionTokens, total_tokens: completionTokens }
    }))
  }

  endSSE(res)
}

function randomId (): string {
  return Math.random().toString(36).slice(2, 12)
}
