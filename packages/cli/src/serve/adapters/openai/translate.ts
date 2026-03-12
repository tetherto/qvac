import type { Logger } from '../../../logger.js'
import type { SDKTool, SDKToolCall } from '../../core/sdk.js'

interface OpenAIMessage {
  role: string
  content: string | null | undefined
}

interface OpenAITool {
  type: string
  function?: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

interface OpenAIToolCall {
  id: string
  type: string
  function: {
    name: string
    arguments: string
  }
}

export function openaiMessagesToHistory (messages: OpenAIMessage[]): Array<{ role: string; content: string }> {
  return messages.map((msg) => ({
    role: msg.role,
    content: typeof msg.content === 'string'
      ? msg.content
      : (msg.content ?? '').toString()
  }))
}

export function openaiToolsToSdk (tools: OpenAITool[] | undefined): SDKTool[] | undefined {
  if (!tools || tools.length === 0) return undefined

  return tools
    .map((t): SDKTool | null => {
      if (t.type !== 'function' || !t.function) return null
      const fn = t.function
      return {
        type: 'function',
        name: fn.name,
        description: fn.description ?? '',
        parameters: fn.parameters ?? { type: 'object', properties: {} }
      }
    })
    .filter((t): t is SDKTool => t !== null)
}

export function sdkToolCallsToOpenai (toolCalls: SDKToolCall[] | null | undefined): OpenAIToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined

  return toolCalls.map((tc) => ({
    id: tc.id,
    type: 'function',
    function: {
      name: tc.name,
      arguments: typeof tc.arguments === 'string'
        ? tc.arguments
        : JSON.stringify(tc.arguments)
    }
  }))
}

const IGNORED_PARAMS = [
  'temperature', 'max_tokens', 'top_p', 'n', 'logprobs',
  'response_format', 'seed', 'frequency_penalty', 'presence_penalty',
  'stop', 'max_completion_tokens'
] as const

export function logUnsupportedParams (body: Record<string, unknown>, logger: Logger): void {
  for (const param of IGNORED_PARAMS) {
    if (body[param] !== undefined) {
      logger.warn(`Ignoring unsupported OpenAI param: ${param}=${JSON.stringify(body[param])}`)
    }
  }
}
