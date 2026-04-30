import type { Logger } from '../../../logger.js'
import type { SDKTool, SDKToolCall, SDKGenerationParams } from '../../core/sdk.js'

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

interface OpenAIToolCallDelta extends OpenAIToolCall {
  index: number
}

export function openaiMessagesToHistory (messages: OpenAIMessage[]): Array<{ role: string; content: string }> {
  return messages.map((msg) => {
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      return { role: 'assistant', content: synthesizeToolCallContent(msg.tool_calls) }
    }

    return {
      role: msg.role,
      content: typeof msg.content === 'string'
        ? msg.content
        : (msg.content ?? '').toString()
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
        parameters: normalizeToolParameters(fn.parameters ?? { type: 'object', properties: {} })
      }
    })
    .filter((t): t is SDKTool => t !== null)
}

const VALID_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array'])

function normalizeToolParameters (params: Record<string, unknown>): Record<string, unknown> {
  const props = params['properties'] as Record<string, Record<string, unknown>> | undefined
  if (!props) return params

  const normalized: Record<string, Record<string, unknown>> = {}
  for (const [key, prop] of Object.entries(props)) {
    normalized[key] = { ...prop, type: normalizeType(prop['type']) }
  }

  return { ...params, properties: normalized }
}

function normalizeType (type: unknown): string {
  if (typeof type === 'string' && VALID_TYPES.has(type)) return type
  if (Array.isArray(type)) {
    const primary = type.find((t): t is string => typeof t === 'string' && t !== 'null' && VALID_TYPES.has(t))
    return primary ?? 'string'
  }
  return 'string'
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

export function sdkToolCallsToOpenaiDeltas (toolCalls: SDKToolCall[] | null | undefined): OpenAIToolCallDelta[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined

  return toolCalls.map((tc, i) => ({
    index: i,
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

export function extractGenerationParams (body: Record<string, unknown>): SDKGenerationParams | undefined {
  const params: SDKGenerationParams = {}

  if (typeof body['temperature'] === 'number') params.temp = body['temperature']
  if (typeof body['top_p'] === 'number') params.top_p = body['top_p']
  if (typeof body['seed'] === 'number') params.seed = body['seed']
  if (typeof body['frequency_penalty'] === 'number') params.frequency_penalty = body['frequency_penalty']
  if (typeof body['presence_penalty'] === 'number') params.presence_penalty = body['presence_penalty']

  if (typeof body['max_tokens'] === 'number') params.predict = body['max_tokens']
  if (typeof body['max_completion_tokens'] === 'number') params.predict = body['max_completion_tokens']

  return Object.keys(params).length > 0 ? params : undefined
}

const UNSUPPORTED_PARAMS = [
  'n', 'logprobs', 'response_format', 'stop', 'top_logprobs',
  'logit_bias', 'parallel_tool_calls', 'stream_options'
] as const

export function logUnsupportedParams (body: Record<string, unknown>, logger: Logger): void {
  for (const param of UNSUPPORTED_PARAMS) {
    if (body[param] !== undefined) {
      logger.warn(`Ignoring unsupported OpenAI param: ${param}=${JSON.stringify(body[param])}`)
    }
  }
}
