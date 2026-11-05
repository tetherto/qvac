import crypto from 'node:crypto'
import type { ToolCall, CompletionStats } from '@qvac/sdk'
import { sdkToolCallsToOpenai } from '@/serve/extensions/openai/adapters/tool-calls'
import { completionTokensFromStats } from '@/serve/core/completion'
import type { ToolNamespaces } from '@/serve/extensions/openai/schemas/responses'

export function responseId(): string {
  return `resp_${randomId()}`
}

export function messageId(): string {
  return `msg_${randomId()}`
}

export function functionCallOutputItemId(): string {
  return `fc_${randomId()}`
}

function randomId(): string {
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
  /** Maps a namespaced tool's qualified name back to the client's `namespace` + `name`. */
  toolNamespaces?: ToolNamespaces
  /** When set, must align with `toolCalls` length; same ids as streamed function_call items. */
  functionCallItemIds?: string[]
  /** From SDK completion stats; `emittedTokens` / `generatedTokens` map to `usage.output_tokens`. */
  stats?: CompletionStats
  /**
   * When set (from `drainCompletion`), wins over stats-derived usage so
   * streaming and blocking Responses stay aligned.
   */
  completionTokens?: number
  /**
   * Terminal `stopReason` from the SDK. `length` maps to OpenAI's
   * `status: 'incomplete'` + `incomplete_details.reason: 'max_output_tokens'`
   * (the Responses-API analogue of chat's `finish_reason: 'length'`), unless
   * tool calls take precedence with `requires_action`.
   */
  stopReason?: string
  /** The request named a KV cache session; only then is `qvac_cache_tokens` reported. */
  kvCached?: boolean
  /** SDK cacheTokens of the last generation round; the stats sum every round. */
  cacheOccupancy?: number
}

export function buildResponseObject(params: BuildResponseObjectParams): Record<string, unknown> {
  const hasToolCalls =
    params.toolCalls !== null && params.toolCalls !== undefined && params.toolCalls.length > 0
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
        ...clientToolName(tc.function.name, params.toolNamespaces),
        arguments: tc.function.arguments,
        status: 'completed'
      })
    }
  }

  const outputTokens =
    typeof params.completionTokens === 'number' && Number.isFinite(params.completionTokens)
      ? params.completionTokens
      : completionTokensFromStats(params.text || '', params.stats)
  // Keep existing OpenAI token accounting. SDK cacheTokens is cache occupancy,
  // not tokens reused by this request, so expose it as a QVAC diagnostic only.
  const inputTokens = 0
  const cacheTokens = params.cacheOccupancy
  const usage = {
    input_tokens: inputTokens,
    ...(params.kvCached &&
    typeof cacheTokens === 'number' &&
    Number.isFinite(cacheTokens) &&
    cacheTokens >= 0
      ? { qvac_cache_tokens: cacheTokens }
      : {}),
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens
  }

  const truncated = !hasToolCalls && params.stopReason === 'length'
  const status = hasToolCalls ? 'requires_action' : truncated ? 'incomplete' : 'completed'

  const base: Record<string, unknown> = {
    id: params.id,
    object: 'response',
    created_at: params.createdAtSec,
    status,
    model: params.modelAlias,
    output,
    output_text: params.text || '',
    usage,
    parallel_tool_calls: params.parallelToolCalls,
    store: params.store
  }

  if (truncated) {
    base['incomplete_details'] = { reason: 'max_output_tokens' }
  }

  if (hasToolCalls) {
    base['required_action'] = {
      type: 'submit_tool_outputs',
      submit_tool_outputs: {
        tool_calls: (openaiCalls ?? []).map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            ...clientToolName(tc.function.name, params.toolNamespaces),
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

/** `name`, plus `namespace` when the tool was declared inside one. */
export function clientToolName(
  name: string,
  namespaces: ToolNamespaces | undefined
): { name: string; namespace?: string } {
  const declared = namespaces?.get(name)
  return declared ? { name: declared.name, namespace: declared.namespace } : { name }
}
