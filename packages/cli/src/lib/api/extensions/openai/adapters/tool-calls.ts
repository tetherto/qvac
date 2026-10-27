import type { ToolCall } from '@qvac/sdk'

export interface OpenAIToolCall {
  id: string
  type: string
  function: {
    name: string
    arguments: string
  }
}

export interface OpenAIToolCallDelta extends OpenAIToolCall {
  index: number
}

export function sdkToolCallsToOpenai(
  toolCalls: ToolCall[] | null | undefined
): OpenAIToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined

  return toolCalls.map((tc) => ({
    id: tc.id,
    type: 'function',
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.arguments)
    }
  }))
}

export function sdkToolCallsToOpenaiDeltas(
  toolCalls: ToolCall[] | null | undefined
): OpenAIToolCallDelta[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined

  return toolCalls.map((tc, i) => ({
    index: i,
    id: tc.id,
    type: 'function',
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.arguments)
    }
  }))
}
