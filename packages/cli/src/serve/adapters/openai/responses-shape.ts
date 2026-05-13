import type { SDKToolCall } from '../../core/sdk.js'
import { sdkToolCallsToOpenai } from './translate.js'

export function responseId (): string {
  return `resp_${randomId()}`
}

export function messageId (): string {
  return `msg_${randomId()}`
}

export function functionCallOutputItemId (): string {
  return `fc_${randomId()}`
}

function randomId (): string {
  return Math.random().toString(36).slice(2, 12)
}

export interface BuildResponseObjectParams {
  id: string
  modelAlias: string
  text: string
  toolCalls: SDKToolCall[] | null | undefined
  createdAtSec: number
  metadata: Record<string, unknown> | null | undefined
  temperature: number | undefined
  topP: number | undefined
  maxOutputTokens: number | undefined
  parallelToolCalls: boolean | undefined
  previousResponseId: string | null | undefined
  store: boolean
}

export function buildResponseObject (params: BuildResponseObjectParams): Record<string, unknown> {
  const hasToolCalls = params.toolCalls !== null && params.toolCalls !== undefined && params.toolCalls.length > 0
  const msgId = messageId()
  const output: unknown[] = []

  if (hasToolCalls) {
    const openaiCalls = sdkToolCallsToOpenai(params.toolCalls)
    for (const tc of openaiCalls ?? []) {
      output.push({
        type: 'function_call',
        id: functionCallOutputItemId(),
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: 'completed'
      })
    }
  } else {
    output.push({
      type: 'message',
      id: msgId,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: params.text || '', annotations: [] }]
    })
  }

  const completionTokens = params.text ? params.text.split(/\s+/).filter(Boolean).length : 0
  const usage = {
    input_tokens: 0,
    output_tokens: completionTokens,
    total_tokens: completionTokens
  }

  const base: Record<string, unknown> = {
    id: params.id,
    object: 'response',
    created_at: params.createdAtSec,
    status: hasToolCalls ? 'requires_action' : 'completed',
    model: params.modelAlias,
    output,
    output_text: hasToolCalls ? '' : (params.text || ''),
    usage,
    parallel_tool_calls: params.parallelToolCalls ?? true,
    store: params.store
  }

  if (params.metadata !== undefined && params.metadata !== null) {
    base['metadata'] = params.metadata
  }
  if (params.temperature !== undefined) base['temperature'] = params.temperature
  if (params.topP !== undefined) base['top_p'] = params.topP
  if (params.maxOutputTokens !== undefined) base['max_output_tokens'] = params.maxOutputTokens
  if (params.previousResponseId) base['previous_response_id'] = params.previousResponseId

  return base
}
