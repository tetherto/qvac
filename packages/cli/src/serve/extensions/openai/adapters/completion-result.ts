import type { CompletionRun, CompletionStats, ToolCall, ToolCallError } from '@qvac/sdk'
import { HttpError } from '@/serve/lib/http-error'

export type OpenAiFinishReason = 'stop' | 'length' | 'tool_calls'

export interface DrainedCompletion {
  text: string
  /** Concatenated `thinkingDelta` text; empty when the SDK captured no reasoning. */
  thinking: string
  toolCalls: ToolCall[]
  /**
   * Tool-call regions the addon emitted but could not parse or validate. OpenAI
   * has no field for these, so routes log them rather than returning them --
   * without that line an empty `stop` response looks like the model simply
   * chose not to call a tool.
   */
  toolErrors: ToolCallError[]
  stats: CompletionStats | undefined
  /**
   * Terminal reason from the SDK `completionDone` event (`eos` / `length` /
   * `stopSequence` / `cancelled`), or undefined if the stream ended without
   * one. `error` and `cancelled` are never present here — `drainCompletion`
   * throws on both (502 for error, `InferenceCancelledError` for cancelled).
   */
  stopReason: string | undefined
  /**
   * OpenAI `usage.completion_tokens`: prefers SDK `stats.emittedTokens`
   * (addon-streamed pieces), then `stats.generatedTokens` (decode count),
   * then a whitespace word count.
   */
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
 * it for blocking responses. Pass `onThinking` to stream reasoning deltas the
 * same way — only produced when the caller enabled `captureThinking` on the
 * SDK request.
 */
export async function drainCompletion(
  result: CompletionRun,
  onToken?: (token: string) => void,
  onThinking?: (token: string) => void
): Promise<DrainedCompletion> {
  let text = ''
  let thinking = ''
  const toolCalls: ToolCall[] = []
  const toolErrors: ToolCallError[] = []
  let stats: CompletionStats | undefined
  let stopReason: string | undefined

  for await (const event of result.events) {
    if (event.type === 'contentDelta') {
      text += event.text
      onToken?.(event.text)
    } else if (event.type === 'thinkingDelta') {
      thinking += event.text
      onThinking?.(event.text)
    } else if (event.type === 'toolCall') {
      toolCalls.push(event.call)
    } else if (event.type === 'toolError') {
      toolErrors.push(event.error)
    } else if (event.type === 'completionStats') {
      stats = event.stats
    } else if (event.type === 'completionDone') {
      if (event.stopReason === 'error') {
        throw new HttpError(502, 'inference_failed', 'Inference failed mid-stream.')
      }
      if (event.stopReason !== undefined) {
        stopReason = event.stopReason
      }
    }
  }

  if (stopReason === 'cancelled') {
    await result.final
  }

  const completionTokens = completionTokensFromStats(text, stats)
  const finishReason: OpenAiFinishReason =
    toolCalls.length > 0 ? 'tool_calls' : stopReason === 'length' ? 'length' : 'stop'

  return {
    text,
    thinking,
    toolCalls,
    toolErrors,
    stats,
    stopReason,
    completionTokens,
    finishReason
  }
}

/**
 * Render drained tool-call failures for the request log: a count plus each
 * distinct error code, e.g. ` toolerrors=2 (PARSE_ERROR)`. Empty string when
 * the run produced none, so it appends cleanly to an existing log line.
 */
export function formatToolErrors(toolErrors: ToolCallError[]): string {
  if (toolErrors.length === 0) {
    return ''
  }
  const codes = [...new Set(toolErrors.map((err) => err.code))].join(',')
  return ` toolerrors=${toolErrors.length} (${codes})`
}

/**
 * OpenAI `usage.completion_tokens` for a drained run.
 *
 * Prefer SDK `emittedTokens` (non-empty addon stream pieces) over
 * `generatedTokens` (`llama_perf` `n_eval`), which can equal the predict /
 * `max_tokens` budget when fewer tokens were streamed. Normalized
 * `contentDelta` / `thinkingDelta` event counts are not used — those are
 * chunk boundaries, not tokenizer tokens.
 */
export function completionTokensFromStats(
  text: string,
  stats: CompletionStats | undefined
): number {
  if (typeof stats?.emittedTokens === 'number' && Number.isFinite(stats.emittedTokens)) {
    return stats.emittedTokens
  }
  if (typeof stats?.generatedTokens === 'number' && Number.isFinite(stats.generatedTokens)) {
    return stats.generatedTokens
  }
  return text ? text.split(/\s+/).filter(Boolean).length : 0
}
