import type { CompletionRun, CompletionStats, ToolCall } from '@qvac/sdk'

export type OpenAiFinishReason = 'stop' | 'length' | 'tool_calls'

export interface DrainedCompletion {
  text: string
  toolCalls: ToolCall[]
  stats: CompletionStats | undefined
  /**
   * Terminal reason from the SDK `completionDone` event (`eos` / `length` /
   * `stopSequence` / `cancelled`), or undefined if the stream ended without
   * one. `error` is never surfaced here — an error completionDone makes
   * `result.events` throw, which propagates out of `drainCompletion`.
   */
  stopReason: string | undefined
  /** `stats.generatedTokens` when the SDK reports it, else a whitespace word count. */
  completionTokens: number
  /** OpenAI `finish_reason`: `tool_calls` wins, then `length` on truncation, else `stop`. */
  finishReason: OpenAiFinishReason
}

/**
 * Single-pass consumer of an SDK completion run, shared by every
 * chat-category route (chat / completions / responses). Draining
 * `result.events` once yields content text, tool calls, stats and the
 * terminal `stopReason` together, so the OpenAI `finish_reason` and token
 * accounting are derived in one place instead of drifting per route.
 *
 * Pass `onToken` to stream content deltas as they arrive (SSE paths); omit
 * it for blocking responses.
 */
export async function drainCompletion (
  result: CompletionRun,
  onToken?: (token: string) => void
): Promise<DrainedCompletion> {
  let text = ''
  const toolCalls: ToolCall[] = []
  let stats: CompletionStats | undefined
  let stopReason: string | undefined

  for await (const event of result.events) {
    if (event.type === 'contentDelta') {
      text += event.text
      onToken?.(event.text)
    } else if (event.type === 'toolCall') {
      toolCalls.push(event.call)
    } else if (event.type === 'completionStats') {
      stats = event.stats
    } else if (event.type === 'completionDone') {
      if (event.stopReason !== undefined && event.stopReason !== 'error') {
        stopReason = event.stopReason
      }
    }
  }

  const completionTokens = completionTokensFromStats(text, stats)
  const finishReason: OpenAiFinishReason =
    toolCalls.length > 0 ? 'tool_calls' : stopReason === 'length' ? 'length' : 'stop'

  return { text, toolCalls, stats, stopReason, completionTokens, finishReason }
}

export function completionTokensFromStats (text: string, stats: CompletionStats | undefined): number {
  if (typeof stats?.generatedTokens === 'number' && Number.isFinite(stats.generatedTokens)) {
    return stats.generatedTokens
  }
  return text ? text.split(/\s+/).filter(Boolean).length : 0
}
