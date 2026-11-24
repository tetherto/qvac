import type { ToolCall } from '@qvac/sdk'
import type { OpenAiFinishReason } from '@/serve/extensions/openai/adapters/completion-result'
import {
  sdkToolCallsToOpenai,
  type OpenAIToolCall,
  type OpenAIToolCallDelta
} from '@/serve/extensions/openai/adapters/tool-calls'

interface ChatCompletionResponseParams {
  id: string
  created: number
  model: string
  text: string
  /** Model reasoning; surfaced as `message.reasoning_content` when present. */
  reasoning?: string
  toolCalls: ToolCall[]
  completionTokens: number
  promptTokens?: number
  cachedTokens?: number
  cacheTokens?: number
  finishReason: OpenAiFinishReason
}

interface ChatCompletionMessage {
  role: 'assistant'
  content: string | null
  reasoning_content?: string
  tool_calls?: OpenAIToolCall[]
}

interface ChatCompletionResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: ChatCompletionMessage
    finish_reason: OpenAiFinishReason
  }>
  usage: ChatCompletionUsage
}

export interface ChatCompletionDelta {
  role?: 'assistant'
  content?: string
  reasoning_content?: string
  tool_calls?: OpenAIToolCallDelta[]
}

interface ChatCompletionChunkParams {
  id: string
  created: number
  model: string
  delta: ChatCompletionDelta
  finishReason: OpenAiFinishReason | null
  usage?: ChatCompletionUsage
}

export interface ChatCompletionUsage {
  prompt_tokens: number
  prompt_tokens_details?: { cached_tokens: number }
  qvac_cache_tokens?: number
  completion_tokens: number
  total_tokens: number
}

/**
 * Builds an OpenAI `usage` object. `promptTokens` is the whole prompt and
 * `cachedTokens` the part of it the KV cache already held. SDK `cacheTokens` is
 * KV-cache occupancy, not this request's reuse; a request that named a cache
 * session passes it and gets it back as `qvac_cache_tokens`.
 */
export function buildUsage(params: {
  completionTokens: number
  promptTokens?: number
  cachedTokens?: number
  cacheTokens?: number
}): ChatCompletionUsage {
  const promptTokens = params.promptTokens ?? 0
  const cacheTokens = params.cacheTokens
  return {
    prompt_tokens: promptTokens,
    ...(params.cachedTokens !== undefined
      ? { prompt_tokens_details: { cached_tokens: Math.min(params.cachedTokens, promptTokens) } }
      : {}),
    ...(typeof cacheTokens === 'number' && Number.isFinite(cacheTokens) && cacheTokens >= 0
      ? { qvac_cache_tokens: cacheTokens }
      : {}),
    completion_tokens: params.completionTokens,
    total_tokens: promptTokens + params.completionTokens
  }
}

interface ChatCompletionChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: ChatCompletionDelta
    finish_reason: OpenAiFinishReason | null
  }>
  usage?: ChatCompletionUsage
}

export function chatCompletionResponse(
  params: ChatCompletionResponseParams
): ChatCompletionResponse {
  const hasToolCalls = params.toolCalls.length > 0
  const message: ChatCompletionMessage = {
    role: 'assistant',
    content: hasToolCalls ? null : params.text || null
  }

  if (params.reasoning) {
    message.reasoning_content = params.reasoning
  }

  if (hasToolCalls) {
    message.tool_calls = sdkToolCallsToOpenai(params.toolCalls) ?? []
  }

  return {
    id: params.id,
    object: 'chat.completion',
    created: params.created,
    model: params.model,
    choices: [{ index: 0, message, finish_reason: params.finishReason }],
    usage: buildUsage({
      completionTokens: params.completionTokens,
      ...(params.promptTokens !== undefined ? { promptTokens: params.promptTokens } : {}),
      ...(params.cachedTokens !== undefined ? { cachedTokens: params.cachedTokens } : {}),
      ...(params.cacheTokens !== undefined ? { cacheTokens: params.cacheTokens } : {})
    })
  }
}

export function chatCompletionChunk(params: ChatCompletionChunkParams): ChatCompletionChunk {
  return {
    id: params.id,
    object: 'chat.completion.chunk',
    created: params.created,
    model: params.model,
    choices: [{ index: 0, delta: params.delta, finish_reason: params.finishReason }],
    ...(params.usage !== undefined ? { usage: params.usage } : {})
  }
}

/**
 * OpenAI streams token usage only when the client sets
 * `stream_options.include_usage`, and delivers it in a trailing chunk whose
 * `choices` array is empty (it follows the finish_reason chunk). Kept separate
 * from `chatCompletionChunk` so a normal delta chunk never ships empty choices.
 */
export function chatCompletionUsageChunk(params: {
  id: string
  created: number
  model: string
  usage: ChatCompletionUsage
}): ChatCompletionChunk {
  return {
    id: params.id,
    object: 'chat.completion.chunk',
    created: params.created,
    model: params.model,
    choices: [],
    usage: params.usage
  }
}
