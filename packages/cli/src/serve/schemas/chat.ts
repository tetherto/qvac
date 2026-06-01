import { z } from 'zod'
import type { Tool } from '@qvac/sdk'
import {
  chatMessage,
  responseFormat,
  toolDef,
  openaiToolsToSdk,
  extractGenerationParams,
  extractResponseFormat,
  type GenerationParams,
  type ResponseFormat
} from './common.js'

export const chatCompletionsBody = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessage),
  stream: z.boolean().optional(),
  tools: z.array(toolDef).optional(),
  response_format: responseFormat.optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().int().optional()
}).passthrough()

export const CHAT_UNSUPPORTED_PARAMS = [
  'logit_bias',
  'n',
  'user',
  'seed',
  'logprobs',
  'top_logprobs',
  'frequency_penalty',
  'presence_penalty',
  'stop'
] as const

interface OpenAIMessage {
  role: string
  content: string | null | undefined
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

export function openaiMessagesToHistory (messages: OpenAIMessage[]): Array<{ role: string; content: string }> {
  return messages.map((msg) => {
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      return { role: 'assistant', content: synthesizeToolCallContent(msg.tool_calls) }
    }
    return {
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : (msg.content ?? '').toString()
    }
  })
}

function synthesizeToolCallContent (toolCalls: NonNullable<OpenAIMessage['tool_calls']>): string {
  return toolCalls.map((tc) => {
    let args: Record<string, unknown>
    try {
      args = JSON.parse(tc.function.arguments) as Record<string, unknown>
    } catch {
      args = {}
    }
    const callObj = { name: tc.function.name, arguments: args }
    return `<tool_call>\n${JSON.stringify(callObj)}\n</tool_call>`
  }).join('\n')
}

export type ChatCompletionsBody = z.infer<typeof chatCompletionsBody>

export interface SdkChatArgs {
  history: Array<{ role: string; content: string }>
  tools: Tool[] | undefined
  generationParams: GenerationParams | undefined
  responseFormat: ResponseFormat | undefined
  stream: boolean
}

export function toSdkChatArgs (body: ChatCompletionsBody): SdkChatArgs {
  const responseFmt = extractResponseFormat(body as Record<string, unknown>)
  return {
    history: openaiMessagesToHistory(body.messages as OpenAIMessage[]),
    tools: openaiToolsToSdk(body.tools as Parameters<typeof openaiToolsToSdk>[0]),
    generationParams: extractGenerationParams(body as Record<string, unknown>, 'max_completion_tokens'),
    responseFormat: responseFmt,
    stream: Boolean(body.stream)
  }
}
