import type { ToolCall } from '@qvac/sdk'
import type { OpenAiFinishReason } from './completion-result.js'
import {
  sdkToolCallsToOpenai,
  type OpenAIToolCall,
  type OpenAIToolCallDelta
} from './tool-calls.js'

interface ChatCompletionResponseParams {
  id: string
  created: number
  model: string
  text: string
  toolCalls: ToolCall[]
  completionTokens: number
  finishReason: OpenAiFinishReason
}

interface ChatCompletionMessage {
  role: 'assistant'
  content: string | null
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
  completion_tokens: number
  total_tokens: number
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

export function chatCompletionResponse (params: ChatCompletionResponseParams): ChatCompletionResponse {
  const hasToolCalls = params.toolCalls.length > 0
  const message: ChatCompletionMessage = {
    role: 'assistant',
    content: hasToolCalls ? null : (params.text || null)
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
    usage: {
      prompt_tokens: 0,
      completion_tokens: params.completionTokens,
      total_tokens: params.completionTokens
    }
  }
}

export function chatCompletionChunk (params: ChatCompletionChunkParams): ChatCompletionChunk {
  return {
    id: params.id,
    object: 'chat.completion.chunk',
    created: params.created,
    model: params.model,
    choices: [{ index: 0, delta: params.delta, finish_reason: params.finishReason }],
    ...(params.usage !== undefined ? { usage: params.usage } : {})
  }
}
