import { unlink } from 'node:fs/promises'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { completion, type CompletionStats } from '@qvac/sdk'
import { HttpError } from '../lib/http-error.js'
import { initSSE, sendSSE, endSSE } from '../lib/sse.js'
import { drainCompletion, type OpenAiFinishReason } from '../adapters/openai/completion-result.js'
import { requireModel } from '../plugins/require-model.js'
import { logUnsupported } from '../plugins/log-unsupported.js'
import {
  chatCompletionsBody,
  CHAT_UNSUPPORTED_PARAMS,
  messagesHaveToolCalls,
  toSdkChatArgs,
  writeChatImages,
  type SdkChatArgs
} from '../schemas/chat.js'
import { resolveToolDialect } from '../lib/tool-dialect.js'
import { InvalidResponseFormatError, UnsupportedImageContentError } from '../schemas/common.js'
import { sdkToolCallsToOpenaiDeltas } from '../adapters/openai/tool-calls.js'
import {
  buildUsage,
  chatCompletionChunk,
  chatCompletionResponse,
  chatCompletionUsageChunk,
  type ChatCompletionDelta
} from '../adapters/openai/chat-shapes.js'

interface PreparedRequest extends SdkChatArgs {
  sdkModelId: string
  modelAlias: string
}

async function prepare(
  req: FastifyRequest,
  body: Parameters<typeof toSdkChatArgs>[0]
): Promise<PreparedRequest> {
  const sdkModelId = req.qvacModel!.sdkModelId
  // Only pay the dialect lookup when a prior assistant tool call must be
  // replayed; the model's native dialect is what keeps the replayed frame from
  // provoking a malformed tool call on the next turn.
  const dialect = messagesHaveToolCalls(
    body.messages as Parameters<typeof messagesHaveToolCalls>[0]
  )
    ? await resolveToolDialect(sdkModelId)
    : 'hermes'

  let sdk: SdkChatArgs
  try {
    sdk = toSdkChatArgs(body, dialect)
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
    sdkModelId,
    modelAlias: req.qvacModel!.alias
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 12)
}

/**
 * Compact one-line render of the SDK completion stats for the request log.
 * Only fields the SDK actually reported are included, so the line stays honest
 * about what was measured (TTFT, decode rate, prompt/cache/generated tokens,
 * backend device).
 */
function formatStats(stats: CompletionStats | undefined): string {
  if (!stats) {
    return ''
  }
  const parts: string[] = []
  if (typeof stats.timeToFirstToken === 'number') {
    parts.push(`ttft=${Math.round(stats.timeToFirstToken)}ms`)
  }
  if (typeof stats.tokensPerSecond === 'number') {
    parts.push(`tps=${stats.tokensPerSecond.toFixed(1)}`)
  }
  if (typeof stats.promptTokens === 'number') {
    parts.push(`prompt=${stats.promptTokens}`)
  }
  if (typeof stats.cacheTokens === 'number') {
    parts.push(`cache=${stats.cacheTokens}`)
  }
  if (typeof stats.generatedTokens === 'number') {
    parts.push(`gen=${stats.generatedTokens}`)
  }
  if (stats.backendDevice !== undefined) {
    parts.push(`backend=${stats.backendDevice}`)
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
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

**Reasoning**: models that emit \`<think>\` blocks (e.g. Qwen3.5) have their
reasoning routed to \`reasoning_content\` (a \`message.reasoning_content\` field
on blocking responses, \`delta.reasoning_content\` chunks when streaming) so it
never appears in \`content\`.

**Token accounting**: \`usage.prompt_tokens\`, \`completion_tokens\` and
\`prompt_tokens_details.cached_tokens\` come from \`CompletionStats\` when the SDK
provides them; \`completion_tokens\` falls back to a whitespace split of the
output otherwise. When streaming, \`usage\` is emitted only if
\`stream_options: { include_usage: true }\` is set, as a final chunk with an
empty \`choices\` array (OpenAI compatibility).
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
      const prepared = await prepare(req, body)
      const streaming = Boolean(body.stream)

      app.qvac.logger.info(
        `  chat model=${prepared.modelAlias} messages=${body.messages.length} stream=${streaming}` +
          `${prepared.tools ? ` tools=${prepared.tools.length}` : ''}` +
          `${prepared.generationParams ? ` genParams=${JSON.stringify(prepared.generationParams)}` : ''}` +
          `${prepared.responseFormat ? ` responseFormat=${prepared.responseFormat.type}` : ''}`
      )

      if (streaming) {
        const includeUsage = body.stream_options?.include_usage === true
        await runStreaming(req, reply, prepared, includeUsage)
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
      captureThinking: true,
      ...(p.tools !== undefined ? { tools: p.tools } : {}),
      ...(p.generationParams !== undefined ? { generationParams: p.generationParams } : {}),
      ...(p.responseFormat !== undefined ? { responseFormat: p.responseFormat } : {})
    })
    req.bindCancel(result.requestId)

    const { text, thinking, toolCalls, stats, completionTokens, finishReason } =
      await drainCompletion(result)

    req.server.qvac.logger.info(
      `  completion done tokens=${completionTokens} finish=${finishReason}${formatStats(stats)}`
    )

    reply.send(
      chatCompletionResponse({
        id: `chatcmpl-${randomId()}`,
        created: Math.floor(Date.now() / 1000),
        model: p.modelAlias,
        text,
        ...(thinking ? { reasoning: thinking } : {}),
        toolCalls,
        completionTokens,
        ...(stats?.promptTokens !== undefined ? { promptTokens: stats.promptTokens } : {}),
        ...(stats?.cacheTokens !== undefined ? { cachedTokens: stats.cacheTokens } : {}),
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
  p: PreparedRequest,
  includeUsage: boolean
): Promise<void> {
  const { history, tmpPaths } = await writeChatImages(p.history)
  try {
    const result = completion({
      modelId: p.sdkModelId,
      history,
      stream: true,
      captureThinking: true,
      ...(p.tools !== undefined ? { tools: p.tools } : {}),
      ...(p.generationParams !== undefined ? { generationParams: p.generationParams } : {}),
      ...(p.responseFormat !== undefined ? { responseFormat: p.responseFormat } : {})
    })
    req.bindCancel(result.requestId)

    initSSE(reply)
    const raw = reply.raw

    const id = `chatcmpl-${randomId()}`
    const created = Math.floor(Date.now() / 1000)

    const chunk = (delta: ChatCompletionDelta, finishReason: OpenAiFinishReason | null) =>
      chatCompletionChunk({
        id,
        created,
        model: p.modelAlias,
        delta,
        finishReason
      })

    sendSSE(raw, chunk({ role: 'assistant', content: '' }, null))

    const { toolCalls, stats, completionTokens, finishReason } = await drainCompletion(
      result,
      (token) => sendSSE(raw, chunk({ content: token }, null)),
      (token) => sendSSE(raw, chunk({ reasoning_content: token }, null))
    )
    const hasToolCalls = toolCalls.length > 0

    req.server.qvac.logger.info(
      `  streaming done tokens=${completionTokens} finish=${finishReason}${formatStats(stats)}`
    )

    if (hasToolCalls) {
      const openaiToolCalls = sdkToolCallsToOpenaiDeltas(toolCalls) ?? []
      sendSSE(raw, chunk({ tool_calls: openaiToolCalls }, null))
      sendSSE(raw, chunk({}, 'tool_calls'))
    } else {
      sendSSE(raw, chunk({}, finishReason))
    }

    if (includeUsage) {
      const usage = buildUsage({
        completionTokens,
        ...(stats?.promptTokens !== undefined ? { promptTokens: stats.promptTokens } : {}),
        ...(stats?.cacheTokens !== undefined ? { cachedTokens: stats.cacheTokens } : {})
      })
      sendSSE(raw, chatCompletionUsageChunk({ id, created, model: p.modelAlias, usage }))
    }

    endSSE(raw)
  } finally {
    await Promise.all(tmpPaths.map((path) => unlink(path).catch(() => undefined)))
  }
}

export default plugin
