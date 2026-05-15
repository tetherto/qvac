import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, sendJson, sendError, initSSE, sendSSE, endSSE } from '../../../http.js'
import { resolveModelAlias } from '../../../config.js'
import { sdkCompletion } from '../../../core/sdk.js'
import type { SDKGenerationParams } from '../../../core/sdk.js'
import {
  parseLegacyPrompt,
  legacyPromptToHistory,
  extractGenerationParams,
  logLegacyUnsupportedParams,
  InvalidPromptError
} from '../translate.js'
import type { RouteContext } from '../../types.js'

interface RouteParams {
  sdkModelId: string
  modelAlias: string
  generationParams: SDKGenerationParams | undefined
  logger: import('../../../../logger.js').Logger
}

export async function handleCompletions (req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
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

  let prompt
  try {
    prompt = parseLegacyPrompt(body['prompt'])
  } catch (err) {
    if (err instanceof InvalidPromptError) {
      sendError(res, 400, 'invalid_prompt', err.message)
      return
    }
    throw err
  }

  const streaming = Boolean(body['stream'])

  if (prompt.kind === 'multi' && streaming) {
    sendError(
      res,
      400,
      'unsupported_streaming',
      'Multi-prompt input cannot be streamed. Send a single string prompt or set "stream" to false.'
    )
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
    sendError(res, 400, 'invalid_model_type', `Model "${modelName}" does not support completions.`)
    return
  }

  const alias = 'alias' in modelEntry ? (modelEntry.alias as string) : modelEntry.id
  const registryEntry = ctx.registry.getEntry(alias)
  if (!registryEntry || registryEntry.state !== ctx.registry.STATES.READY) {
    sendError(res, 503, 'model_not_ready', `Model "${modelName}" is not loaded yet.`)
    return
  }

  logLegacyUnsupportedParams(body, ctx.logger)

  const sdkModelId = registryEntry.sdkModelId ?? registryEntry.id
  const generationParams = extractGenerationParams(body)
  const params: RouteParams = { sdkModelId, modelAlias: alias, generationParams, logger: ctx.logger }

  const promptCount = prompt.kind === 'single' ? 1 : prompt.values.length
  ctx.logger.info(`  completions model=${alias} prompts=${promptCount} stream=${streaming}${generationParams ? ` genParams=${JSON.stringify(generationParams)}` : ''}`)

  try {
    if (prompt.kind === 'single' && streaming) {
      await handleStreamingCompletion(res, params, prompt.value)
    } else if (prompt.kind === 'single') {
      await handleBlockingSingle(res, params, prompt.value)
    } else {
      await handleBlockingMulti(res, params, prompt.values)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.error(`Completion error for "${alias}": ${message}`)
    sendError(res, 500, 'completion_error', 'An internal error occurred during completion.')
  }
}

async function handleBlockingSingle (res: ServerResponse, params: RouteParams, prompt: string): Promise<void> {
  const choice = await runOne(params, prompt, 0)

  params.logger.info(`  completions done tokens=${choice.tokenCount} finish=${choice.finish_reason}`)

  sendJson(res, 200, {
    id: `cmpl-${randomId()}`,
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model: params.modelAlias,
    choices: [choice.public],
    usage: {
      prompt_tokens: 0,
      completion_tokens: choice.tokenCount,
      total_tokens: choice.tokenCount
    }
  })
}

async function handleBlockingMulti (res: ServerResponse, params: RouteParams, prompts: string[]): Promise<void> {
  const choices = []
  let totalTokens = 0

  for (let i = 0; i < prompts.length; i++) {
    const result = await runOne(params, prompts[i]!, i)
    choices.push(result.public)
    totalTokens += result.tokenCount
  }

  params.logger.info(`  completions done prompts=${prompts.length} tokens=${totalTokens}`)

  sendJson(res, 200, {
    id: `cmpl-${randomId()}`,
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model: params.modelAlias,
    choices,
    usage: {
      prompt_tokens: 0,
      completion_tokens: totalTokens,
      total_tokens: totalTokens
    }
  })
}

interface ChoiceResult {
  public: { text: string; index: number; logprobs: null; finish_reason: 'stop' }
  tokenCount: number
  finish_reason: 'stop'
}

async function runOne (params: RouteParams, prompt: string, index: number): Promise<ChoiceResult> {
  const result = await sdkCompletion({
    modelId: params.sdkModelId,
    history: legacyPromptToHistory(prompt),
    stream: false,
    generationParams: params.generationParams
  })

  const text = await result.text
  // TODO(QVAC-18522 follow-up): derive `finish_reason` from `result.stats`
  // ('length' on max_tokens cap, 'stop' otherwise) and unify token accounting
  // with the chat route's `completionTokensFromStats` helper. Same drift
  // exists in the streaming path below and in chat.ts.
  const tokenCount = text ? text.split(/\s+/).filter(Boolean).length : 0

  return {
    public: { text: text ?? '', index, logprobs: null, finish_reason: 'stop' },
    tokenCount,
    finish_reason: 'stop'
  }
}

async function handleStreamingCompletion (res: ServerResponse, params: RouteParams, prompt: string): Promise<void> {
  const result = await sdkCompletion({
    modelId: params.sdkModelId,
    history: legacyPromptToHistory(prompt),
    stream: true,
    generationParams: params.generationParams
  })

  initSSE(res)

  const id = `cmpl-${randomId()}`
  const created = Math.floor(Date.now() / 1000)

  const chunk = (text: string, finishReason: string | null, extra?: Record<string, unknown>) => ({
    id,
    object: 'text_completion',
    created,
    model: params.modelAlias,
    choices: [{ text, index: 0, logprobs: null, finish_reason: finishReason }],
    ...extra
  })

  let tokenCount = 0

  for await (const token of result.tokenStream) {
    tokenCount++
    sendSSE(res, chunk(token, null))
  }

  params.logger.info(`  completions streaming done tokens=${tokenCount}`)

  sendSSE(res, chunk('', 'stop', {
    usage: { prompt_tokens: 0, completion_tokens: tokenCount, total_tokens: tokenCount }
  }))

  endSSE(res)
}

function randomId (): string {
  return Math.random().toString(36).slice(2, 12)
}
