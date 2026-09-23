import type { CompletionRun } from '@qvac/sdk'
import {
  drainCompletion as drainCompletionRun,
  type DrainedCompletion
} from '@/serve/core/completion'

export type OpenAiFinishReason = 'stop' | 'length' | 'tool_calls'

export interface DrainedOpenAICompletion extends DrainedCompletion {
  /** `tool_calls` wins, then `length` on truncation, else `stop`. */
  finishReason: OpenAiFinishReason
}

export function toOpenAiFinishReason(
  drained: Pick<DrainedCompletion, 'toolCalls' | 'stopReason'>
): OpenAiFinishReason {
  if (drained.toolCalls.length > 0) return 'tool_calls'
  return drained.stopReason === 'length' ? 'length' : 'stop'
}

export async function drainCompletion(
  result: CompletionRun,
  onToken?: (token: string) => void,
  onThinking?: (token: string) => void
): Promise<DrainedOpenAICompletion> {
  const drained = await drainCompletionRun(result, onToken, onThinking)
  return { ...drained, finishReason: toOpenAiFinishReason(drained) }
}
