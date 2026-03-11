import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, sendJson, sendError, initSSE, sendSSE, endSSE } from '../../../http.js'
import { resolveModelAlias } from '../../../config.js'
import { sdkCompletion } from '../../../core/sdk.js'
import type { SDKTool } from '../../../core/sdk.js'
import {
  openaiMessagesToHistory,
  openaiToolsToSdk,
  sdkToolCallsToOpenai,
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
  const history = openaiMessagesToHistory(body['messages'] as Array<{ role: string; content: string }>)
  const tools = openaiToolsToSdk(body['tools'] as Array<{ type: string; function?: { name: string; description?: string; parameters?: Record<string, unknown> } }> | undefined)
  const modelAlias = alias
  const streaming = Boolean(body['stream'])
  const msgCount = (body['messages'] as unknown[]).length

  ctx.logger.info(`  chat model=${modelAlias} messages=${msgCount} stream=${streaming}${tools ? ` tools=${tools.length}` : ''}`)

  try {
    if (streaming) {
      await handleStreamingCompletion(res, { sdkModelId, history, tools, modelAlias, logger: ctx.logger })
    } else {
      await handleBlockingCompletion(res, { sdkModelId, history, tools, modelAlias, logger: ctx.logger })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.error(`Completion error for "${modelAlias}": ${message}`)
    sendError(res, 500, 'completion_error', message)
  }
}

interface CompletionParams {
  sdkModelId: string
  history: Array<{ role: string; content: string }>
  tools?: SDKTool[] | undefined
  modelAlias: string
  logger: import('../../../../logger.js').Logger
}

async function handleBlockingCompletion (res: ServerResponse, params: CompletionParams): Promise<void> {
  const result = await sdkCompletion({
    modelId: params.sdkModelId,
    history: params.history,
    stream: false,
    tools: params.tools
  })

  const text = await result.text
  const toolCalls = await result.toolCalls

  const hasToolCalls = toolCalls !== null && toolCalls !== undefined && toolCalls.length > 0
  const finishReason = hasToolCalls ? 'tool_calls' : 'stop'

  const message: Record<string, unknown> = { role: 'assistant', content: text || null }
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
    tools: params.tools
  })

  initSSE(res)

  const id = `chatcmpl-${randomId()}`
  const created = Math.floor(Date.now() / 1000)

  sendSSE(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model: params.modelAlias,
    choices: [{
      index: 0,
      delta: { role: 'assistant', content: '' },
      finish_reason: null
    }]
  })

  let tokenCount = 0

  for await (const token of result.tokenStream) {
    tokenCount++
    sendSSE(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model: params.modelAlias,
      choices: [{
        index: 0,
        delta: { content: token },
        finish_reason: null
      }]
    })
  }

  params.logger.info(`  streaming done tokens=${tokenCount}`)

  const toolCalls = await result.toolCalls
  if (toolCalls && toolCalls.length > 0) {
    const openaiToolCalls = sdkToolCallsToOpenai(toolCalls)
    sendSSE(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model: params.modelAlias,
      choices: [{
        index: 0,
        delta: { tool_calls: openaiToolCalls },
        finish_reason: 'tool_calls'
      }]
    })
  } else {
    sendSSE(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model: params.modelAlias,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: tokenCount,
        total_tokens: tokenCount
      }
    })
  }

  endSSE(res)
}

function randomId (): string {
  return Math.random().toString(36).slice(2, 12)
}
