import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { completion } from '@qvac/sdk'
import { HttpError } from '../lib/http-error.js'
import { initSSE, sendSSE, endSSE } from '../lib/sse.js'
import { drainCompletion, type OpenAiFinishReason } from '../adapters/openai/completion-result.js'
import { requireModel } from '../plugins/require-model.js'
import { logUnsupported } from '../plugins/log-unsupported.js'
import {
  completionsBody,
  COMPLETIONS_UNSUPPORTED_PARAMS,
  legacyPromptToHistory,
  InvalidPromptError,
  toSdkCompletionsArgs
} from '../schemas/completions.js'
import type { GenerationParams } from '../schemas/common.js'

function randomId (): string {
  return Math.random().toString(36).slice(2, 12)
}

interface SharedParams {
  sdkModelId: string
  modelAlias: string
  generationParams: GenerationParams | undefined
}

async function runBlockingSingle (req: FastifyRequest, reply: FastifyReply, p: SharedParams, prompt: string): Promise<void> {
  const choice = await runOne(req, p, prompt, 0)
  req.server.qvac.logger.info(`  completions done tokens=${choice.tokenCount} finish=${choice.finishReason}`)
  reply.send({
    id: `cmpl-${randomId()}`,
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model: p.modelAlias,
    choices: [choice.public],
    usage: { prompt_tokens: 0, completion_tokens: choice.tokenCount, total_tokens: choice.tokenCount }
  })
}

async function runBlockingMulti (req: FastifyRequest, reply: FastifyReply, p: SharedParams, prompts: string[]): Promise<void> {
  const choices = []
  let totalTokens = 0
  for (let i = 0; i < prompts.length; i++) {
    const r = await runOne(req, p, prompts[i]!, i)
    choices.push(r.public)
    totalTokens += r.tokenCount
  }
  req.server.qvac.logger.info(`  completions done prompts=${prompts.length} tokens=${totalTokens}`)
  reply.send({
    id: `cmpl-${randomId()}`,
    object: 'text_completion',
    created: Math.floor(Date.now() / 1000),
    model: p.modelAlias,
    choices,
    usage: { prompt_tokens: 0, completion_tokens: totalTokens, total_tokens: totalTokens }
  })
}

async function runOne (req: FastifyRequest, p: SharedParams, prompt: string, index: number): Promise<{ public: { text: string; index: number; logprobs: null; finish_reason: OpenAiFinishReason }; tokenCount: number; finishReason: OpenAiFinishReason }> {
  const result = completion({
    modelId: p.sdkModelId,
    history: legacyPromptToHistory(prompt),
    stream: false,
    ...(p.generationParams !== undefined ? { generationParams: p.generationParams } : {})
  })
  req.bindCancel(result.requestId)
  const { text, completionTokens, finishReason } = await drainCompletion(result)
  return {
    public: { text, index, logprobs: null, finish_reason: finishReason },
    tokenCount: completionTokens,
    finishReason
  }
}

async function runStreaming (req: FastifyRequest, reply: FastifyReply, p: SharedParams, prompt: string): Promise<void> {
  const result = completion({
    modelId: p.sdkModelId,
    history: legacyPromptToHistory(prompt),
    stream: true,
    ...(p.generationParams !== undefined ? { generationParams: p.generationParams } : {})
  })
  req.bindCancel(result.requestId)
  initSSE(reply)
  const raw = reply.raw
  const id = `cmpl-${randomId()}`
  const created = Math.floor(Date.now() / 1000)
  const chunk = (text: string, finishReason: string | null, extra?: Record<string, unknown>): Record<string, unknown> => ({
    id,
    object: 'text_completion',
    created,
    model: p.modelAlias,
    choices: [{ text, index: 0, logprobs: null, finish_reason: finishReason }],
    ...extra
  })

  const { completionTokens, finishReason } = await drainCompletion(
    result,
    (token) => sendSSE(raw, chunk(token, null))
  )

  req.server.qvac.logger.info(`  completions streaming done tokens=${completionTokens} finish=${finishReason}`)
  sendSSE(raw, chunk('', finishReason, {
    usage: { prompt_tokens: 0, completion_tokens: completionTokens, total_tokens: completionTokens }
  }))
  endSSE(raw)
}

const descriptions = {
  completion: `
Legacy text completion. \`prompt\` accepts a single string or an array of strings;
token-id prompts (numeric arrays) are rejected with \`invalid_prompt\`.

**Multi-prompt + \`stream: true\`** is rejected with \`unsupported_streaming\` —
each prompt would need its own SSE stream which we don't support.

**Implementation note**: under the hood this routes through the same SDK
\`completion()\` capability as \`/v1/chat/completions\`, wrapping each prompt
as a single \`user\` turn. The SDK chat template still applies, so legacy
clients expecting raw completion semantics may see template-shaped output.

**Ignored params** (warned, not rejected): \`logit_bias\`, \`n\` (>1),
\`user\`, \`seed\`, \`logprobs\`, \`best_of\`, \`echo\`, \`suffix\`,
\`frequency_penalty\`, \`presence_penalty\`, \`stop\`.
`.trim()
}

const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post('/v1/completions', {
    schema: { body: completionsBody, tags: ['Completions'], summary: 'Legacy text completion', description: descriptions.completion },
    config: { unsupportedParams: [...COMPLETIONS_UNSUPPORTED_PARAMS] },
    preHandler: [requireModel('chat'), logUnsupported]
  }, async (req, reply) => {
    let sdk
    try {
      sdk = toSdkCompletionsArgs(req.body)
    } catch (err) {
      if (err instanceof InvalidPromptError) {
        throw new HttpError(400, 'invalid_prompt', err.message)
      }
      throw err
    }

    if (sdk.prompt.kind === 'multi' && sdk.stream) {
      throw new HttpError(
        400,
        'unsupported_streaming',
        'Multi-prompt input cannot be streamed. Send a single string prompt or set "stream" to false.'
      )
    }

    const shared: SharedParams = {
      sdkModelId: req.qvacModel!.sdkModelId,
      modelAlias: req.qvacModel!.alias,
      generationParams: sdk.generationParams
    }

    const promptCount = sdk.prompt.kind === 'single' ? 1 : sdk.prompt.values.length
    app.qvac.logger.info(
      `  completions model=${shared.modelAlias} prompts=${promptCount} stream=${sdk.stream}` +
      `${shared.generationParams ? ` genParams=${JSON.stringify(shared.generationParams)}` : ''}`
    )

    if (sdk.prompt.kind === 'single' && sdk.stream) {
      await runStreaming(req, reply, shared, sdk.prompt.value)
    } else if (sdk.prompt.kind === 'single') {
      await runBlockingSingle(req, reply, shared, sdk.prompt.value)
    } else {
      await runBlockingMulti(req, reply, shared, sdk.prompt.values)
    }
  })
}

export default plugin
