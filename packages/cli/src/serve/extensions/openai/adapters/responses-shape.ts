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

export function reasoningItemId(): string {
  return `rs_${randomId()}`
}

export function functionCallOutputItemId(): string {
  return `fc_${randomId()}`
}

function randomId(): string {
  return crypto.randomUUID()
}

/** One output item, in the order the model produced it. */
export type OutputSegment =
  | { type: 'message' | 'reasoning'; id: string; text: string }
  | {
      type: 'function_call'
      id: string
      callId: string
      /** As the client declared it; a namespaced tool's `namespace` is split out. */
      name: string
      namespace?: string
      arguments: string
    }

type FunctionCallSegment = Extract<OutputSegment, { type: 'function_call' }>

export interface BuildResponseObjectParams {
  id: string
  modelAlias: string
  /** The answer, all message text joined; `output_text`. */
  text: string
  /**
   * Output items in order, function calls included. Without it, `output` holds
   * one message carrying `text`, then a `function_call` per entry of `toolCalls`.
   */
  items?: OutputSegment[]
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
}

export function buildResponseObject(params: BuildResponseObjectParams): Record<string, unknown> {
  // Every tool-call field (output items, status, required_action) comes from
  // this one list: the ordered items when given, otherwise `toolCalls`.
  const calls: FunctionCallSegment[] = params.items
    ? params.items.filter((item): item is FunctionCallSegment => item.type === 'function_call')
    : (sdkToolCallsToOpenai(params.toolCalls) ?? []).map((tc, i) => ({
        type: 'function_call',
        id: params.functionCallItemIds?.[i] ?? functionCallOutputItemId(),
        callId: tc.id,
        ...clientToolName(tc.function.name, params.toolNamespaces),
        arguments: tc.function.arguments
      }))
  const hasToolCalls = calls.length > 0
  const output: unknown[] = params.items
    ? params.items.map(outputItem)
    : [
        messageItem(params.messageItemId ?? messageId(), params.text || ''),
        ...calls.map((call) => functionCallItem(call, 'completed'))
      ]

  const outputTokens =
    typeof params.completionTokens === 'number' && Number.isFinite(params.completionTokens)
      ? params.completionTokens
      : completionTokensFromStats(params.text || '', params.stats)
  const inputTokens = inputTokensFromStats(params.stats)
  const usage = {
    input_tokens: inputTokens,
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
        tool_calls: calls.map((call) => ({
          id: call.callId,
          type: 'function',
          function: {
            name: call.name,
            ...(call.namespace !== undefined && { namespace: call.namespace }),
            arguments: call.arguments
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

export function reasoningItem(id: string, text: string): Record<string, unknown> {
  return {
    type: 'reasoning',
    id,
    status: 'completed',
    summary: [],
    content: [{ type: 'reasoning_text', text }]
  }
}

export function messageItem(id: string, text: string): Record<string, unknown> {
  return {
    type: 'message',
    id,
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }]
  }
}

// On a KV-cache hit the SDK's promptTokens counts only the newly evaluated
// tail. cacheTokens is what the context holds after the run (the whole prompt
// plus what was generated), so the full input is that minus the generated part.
// cacheTokens is scheduler-wide, though: when other requests overlapped this
// one it includes theirs, so promptTokens, this request's own, is used instead.
function inputTokensFromStats(stats: CompletionStats | undefined): number {
  const prompt = stats?.promptTokens ?? 0
  const held = stats?.cacheTokens
  const generated = stats?.generatedTokens
  if (typeof held !== 'number' || typeof generated !== 'number') return prompt
  if ((stats?.avgConcurrentSeq ?? 1) > 1) return prompt
  return Math.max(prompt, held - generated)
}

export function functionCallItem(
  item: FunctionCallSegment,
  status: 'in_progress' | 'completed'
): Record<string, unknown> {
  return {
    type: 'function_call',
    id: item.id,
    call_id: item.callId,
    name: item.name,
    ...(item.namespace !== undefined && { namespace: item.namespace }),
    arguments: status === 'completed' ? item.arguments : '',
    status
  }
}

export function outputItem(item: OutputSegment): Record<string, unknown> {
  if (item.type === 'function_call') return functionCallItem(item, 'completed')
  return item.type === 'message'
    ? messageItem(item.id, item.text)
    : reasoningItem(item.id, item.text)
}

/** `name`, plus `namespace` when the tool was declared inside one. */
export function clientToolName(
  name: string,
  namespaces: ToolNamespaces | undefined
): { name: string; namespace?: string } {
  const declared = namespaces?.get(name)
  return declared ? { name: declared.name, namespace: declared.namespace } : { name }
}
