import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, sendJson, sendError, initSSE, sendSSE, endSSE } from '../../../http.js'
import { resolveModelAlias } from '../../../config.js'
import { sdkCompletion } from '../../../core/sdk.js'
import type { SDKTool, SDKGenerationParams } from '../../../core/sdk.js'
import {
  openaiMessagesToHistory,
  openaiToolsToSdk,
  sdkToolCallsToOpenai,
  sdkToolCallsToOpenaiDeltas,
  extractGenerationParams,
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
  const modelAlias = alias
  const streaming = Boolean(body['stream'])
  const msgCount = (body['messages'] as unknown[]).length

  ctx.logger.info(`  chat model=${modelAlias} messages=${msgCount} stream=${streaming}${tools ? ` tools=${tools.length}` : ''}${generationParams ? ` genParams=${JSON.stringify(generationParams)}` : ''}`)

  try {
    if (streaming) {
      await handleStreamingCompletion(res, { sdkModelId, history, tools, generationParams, modelAlias, logger: ctx.logger })
    } else {
      await handleBlockingCompletion(res, { sdkModelId, history, tools, generationParams, modelAlias, logger: ctx.logger })
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
  modelAlias: string
  logger: import('../../../../logger.js').Logger
}

async function handleBlockingCompletion (res: ServerResponse, params: CompletionParams): Promise<void> {
  const result = await sdkCompletion({
    modelId: params.sdkModelId,
    history: params.history,
    stream: false,
    tools: params.tools,
    generationParams: params.generationParams
  })

  const text = await result.text
  const toolCalls = await result.toolCalls

  const hasToolCalls = toolCalls !== null && toolCalls !== undefined && toolCalls.length > 0
  const finishReason = hasToolCalls ? 'tool_calls' : 'stop'

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: hasToolCalls ? null : (text || null)
  }
  if (hasToolCalls) {
    message['tool_calls'] = sdkToolCallsToOpenai(toolCalls)
  }

  const completionTokens = text ? text.split(/\s+/).length : 0

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

async function handleStreamingCompletion (res: ServerResponse, params: CompletionParams): Promise<void> {
  const result = await sdkCompletion({
    modelId: params.sdkModelId,
    history: params.history,
    stream: true,
    tools: params.tools,
    generationParams: params.generationParams
  })

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

  let tokenCount = 0

  for await (const token of result.tokenStream) {
    tokenCount++
    sendSSE(res, chunk({ content: token }, null))
  }

  params.logger.info(`  streaming done tokens=${tokenCount}`)

  const toolCalls = await result.toolCalls
  const hasToolCalls = toolCalls !== null && toolCalls !== undefined && toolCalls.length > 0

  if (hasToolCalls) {
    const openaiToolCalls = sdkToolCallsToOpenaiDeltas(toolCalls)
    sendSSE(res, chunk({ tool_calls: openaiToolCalls }, null))
    sendSSE(res, chunk({}, 'tool_calls'))
  } else {
    sendSSE(res, chunk({}, 'stop', {
      usage: { prompt_tokens: 0, completion_tokens: tokenCount, total_tokens: tokenCount }
    }))
  }

  endSSE(res)
}

function randomId (): string {
  return Math.random().toString(36).slice(2, 12)
}
