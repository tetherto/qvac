import { unlink } from 'node:fs/promises'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { completion } from '@qvac/sdk'
import { HttpError } from '../lib/http-error.js'
import { initSSE, sendSSE, endSSE } from '../lib/sse.js'
import { drainCompletion, type OpenAiFinishReason } from '../adapters/openai/completion-result.js'
import { requireModel } from '../plugins/require-model.js'
import { logUnsupported } from '../plugins/log-unsupported.js'
import {
  chatCompletionsBody,
  CHAT_UNSUPPORTED_PARAMS,
  toSdkChatArgs,
  writeChatImages,
  type SdkChatArgs
} from '../schemas/chat.js'
import { InvalidResponseFormatError, UnsupportedImageContentError } from '../schemas/common.js'
import { sdkToolCallsToOpenaiDeltas } from '../adapters/openai/tool-calls.js'
import {
  chatCompletionChunk,
  chatCompletionResponse,
  type ChatCompletionDelta,
  type ChatCompletionUsage
} from '../adapters/openai/chat-shapes.js'

interface PreparedRequest extends SdkChatArgs {
  sdkModelId: string
  modelAlias: string
}

function prepare(req: FastifyRequest, body: Parameters<typeof toSdkChatArgs>[0]): PreparedRequest {
  let sdk: SdkChatArgs
  try {
    sdk = toSdkChatArgs(body)
  } catch (err) {
    if (err instanceof InvalidResponseFormatError) {
      throw new HttpError(400, 'invalid_response_format', err.message)
    }
    if (err instanceof UnsupportedImageContentError) {
      throw new HttpError(400, 'unsupported_image_content', err.message)
    }
    throw err
  }

  if (
    sdk.responseFormat &&
    sdk.responseFormat.type !== 'text' &&
    sdk.tools &&
    sdk.tools.length > 0
  ) {
    throw new HttpError(
      400,
      'invalid_response_format',
      '"response_format" (json_object/json_schema) cannot be combined with "tools".'
    )
  }

  return {
    ...sdk,
    sdkModelId: req.qvacModel!.sdkModelId,
    modelAlias: req.qvacModel!.alias
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 12)
}

const descriptions = {
  completion: `
OpenAI-compatible chat completion. Accepts a chat-style \`messages\` array,
optional \`tools\` for function-calling, and an optional \`response_format\`
(\`text\` / \`json_object\` / \`json_schema\`).

**Streaming**: pass \`stream: true\` to receive Server-Sent Events. The stream
ends with \`data: [DONE]\\n\\n\` (OpenAI compatibility).

**Tools + structured output**: combining \`tools\` with
\`response_format: { type: 'json_object' | 'json_schema' }\` is rejected with
\`invalid_response_format\`.

**Ignored params** (warned, not rejected): \`logit_bias\`, \`n\`, \`user\`,
\`seed\`, \`logprobs\`, \`top_logprobs\`, \`frequency_penalty\`,
\`presence_penalty\`, \`stop\`.

**Token accounting**: \`usage.prompt_tokens\` is reported as 0;
\`completion_tokens\` comes from \`CompletionStats.generatedTokens\` when the
SDK provides it, otherwise from a whitespace split of the output.
`.trim()
}

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/v1/chat/completions',
    {
      schema: {
        body: chatCompletionsBody,
        tags: ['Chat'],
        summary: 'Chat completion',
        description: descriptions.completion
      },
      config: { unsupportedParams: [...CHAT_UNSUPPORTED_PARAMS] },
      preHandler: [requireModel('chat'), logUnsupported]
    },
    async (req, reply) => {
      const body = req.body
      const prepared = prepare(req, body)
      const streaming = Boolean(body.stream)

      app.qvac.logger.info(
        `  chat model=${prepared.modelAlias} messages=${body.messages.length} stream=${streaming}` +
          `${prepared.tools ? ` tools=${prepared.tools.length}` : ''}` +
          `${prepared.generationParams ? ` genParams=${JSON.stringify(prepared.generationParams)}` : ''}` +
          `${prepared.responseFormat ? ` responseFormat=${prepared.responseFormat.type}` : ''}`
      )

      if (streaming) {
        await runStreaming(req, reply, prepared)
        return
      }
      await runBlocking(req, reply, prepared)
    }
  )
}

async function runBlocking(
  req: FastifyRequest,
  reply: FastifyReply,
  p: PreparedRequest
): Promise<void> {
  const { history, tmpPaths } = await writeChatImages(p.history)
  try {
    const result = completion({
      modelId: p.sdkModelId,
      history,
      stream: false,
      ...(p.tools !== undefined ? { tools: p.tools } : {}),
      ...(p.generationParams !== undefined ? { generationParams: p.generationParams } : {}),
      ...(p.responseFormat !== undefined ? { responseFormat: p.responseFormat } : {})
    })
    req.bindCancel(result.requestId)

    const { text, toolCalls, completionTokens, finishReason } = await drainCompletion(result)

    req.server.qvac.logger.info(
      `  completion done tokens=${completionTokens} finish=${finishReason}`
    )

    reply.send(
      chatCompletionResponse({
        id: `chatcmpl-${randomId()}`,
        created: Math.floor(Date.now() / 1000),
        model: p.modelAlias,
        text,
        toolCalls,
        completionTokens,
        finishReason
      })
    )
  } finally {
    await Promise.all(tmpPaths.map((path) => unlink(path).catch(() => undefined)))
  }
}

async function runStreaming(
  req: FastifyRequest,
  reply: FastifyReply,
  p: PreparedRequest
): Promise<void> {
  const { history, tmpPaths } = await writeChatImages(p.history)
  try {
    const result = completion({
      modelId: p.sdkModelId,
      history,
      stream: true,
      ...(p.tools !== undefined ? { tools: p.tools } : {}),
      ...(p.generationParams !== undefined ? { generationParams: p.generationParams } : {}),
      ...(p.responseFormat !== undefined ? { responseFormat: p.responseFormat } : {})
    })
    req.bindCancel(result.requestId)

    initSSE(reply)
    const raw = reply.raw

    const id = `chatcmpl-${randomId()}`
    const created = Math.floor(Date.now() / 1000)

    const chunk = (
      delta: ChatCompletionDelta,
      finishReason: OpenAiFinishReason | null,
      usage?: ChatCompletionUsage
    ) =>
      chatCompletionChunk({
        id,
        created,
        model: p.modelAlias,
        delta,
        finishReason,
        ...(usage !== undefined ? { usage } : {})
      })

    sendSSE(raw, chunk({ role: 'assistant', content: '' }, null))

    const { toolCalls, completionTokens, finishReason } = await drainCompletion(result, (token) =>
      sendSSE(raw, chunk({ content: token }, null))
    )
    const hasToolCalls = toolCalls.length > 0

    req.server.qvac.logger.info(
      `  streaming done tokens=${completionTokens} finish=${finishReason}`
    )

    if (hasToolCalls) {
      const openaiToolCalls = sdkToolCallsToOpenaiDeltas(toolCalls) ?? []
      sendSSE(raw, chunk({ tool_calls: openaiToolCalls }, null))
      sendSSE(raw, chunk({}, 'tool_calls'))
    } else {
      sendSSE(
        raw,
        chunk({}, finishReason, {
          prompt_tokens: 0,
          completion_tokens: completionTokens,
          total_tokens: completionTokens
        })
      )
    }

    endSSE(raw)
  } finally {
    await Promise.all(tmpPaths.map((path) => unlink(path).catch(() => undefined)))
  }
}

export default plugin
