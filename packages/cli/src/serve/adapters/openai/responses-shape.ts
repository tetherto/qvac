import crypto from 'node:crypto'
import type { ToolCall, CompletionStats } from '@qvac/sdk'
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
  return crypto.randomUUID()
}

export interface BuildResponseObjectParams {
  id: string
  modelAlias: string
  text: string
  toolCalls: ToolCall[] | null | undefined
  createdAtSec: number
  metadata: Record<string, unknown> | null | undefined
  temperature: number | undefined
  topP: number | undefined
  maxOutputTokens: number | undefined
  parallelToolCalls: boolean
  previousResponseId: string | null | undefined
  store: boolean
  /** When set (e.g. streaming), must match SSE item ids so finalized response matches the stream. */
  messageItemId?: string
  /** When set, must align with `toolCalls` length; same ids as streamed function_call items. */
  functionCallItemIds?: string[]
  /** From SDK completion stats; `generatedTokens` maps to `usage.output_tokens`. */
  stats?: CompletionStats
}

function wordCountFallback (text: string): number {
  return text ? text.split(/\s+/).filter(Boolean).length : 0
}

export function buildResponseObject (params: BuildResponseObjectParams): Record<string, unknown> {
  const hasToolCalls = params.toolCalls !== null && params.toolCalls !== undefined && params.toolCalls.length > 0
  const msgId = params.messageItemId ?? messageId()
  const output: unknown[] = []

  output.push({
    type: 'message',
    id: msgId,
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: params.text || '', annotations: [] }]
  })

  const openaiCalls = sdkToolCallsToOpenai(params.toolCalls)
  if (hasToolCalls) {
    const ids = params.functionCallItemIds
    let i = 0
    for (const tc of openaiCalls ?? []) {
      const fcId = ids !== undefined && ids[i] !== undefined ? ids[i]! : functionCallOutputItemId()
      i++
      output.push({
        type: 'function_call',
        id: fcId,
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: 'completed'
      })
    }
  }

  const outputTokens =
    typeof params.stats?.generatedTokens === 'number' && Number.isFinite(params.stats.generatedTokens)
      ? params.stats.generatedTokens
      : wordCountFallback(params.text || '')
  // SDK does not expose prompt token count today; `cacheTokens` is KV-cache hit count, not full prompt size.
  const inputTokens = 0
  const usage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens
  }

  const base: Record<string, unknown> = {
    id: params.id,
    object: 'response',
    created_at: params.createdAtSec,
    status: hasToolCalls ? 'requires_action' : 'completed',
    model: params.modelAlias,
    output,
    output_text: params.text || '',
    usage,
    parallel_tool_calls: params.parallelToolCalls,
    store: params.store
  }

  if (hasToolCalls) {
    base['required_action'] = {
      type: 'submit_tool_outputs',
      submit_tool_outputs: {
        tool_calls: (openaiCalls ?? []).map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments
          }
        }))
      }
    }
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
