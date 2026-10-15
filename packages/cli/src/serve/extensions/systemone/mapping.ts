import type { DecideParams, DecisionResult } from '@qvac/sdk'
import type { SystemOneBody, SystemOneResult } from '@/serve/extensions/systemone/schemas'

export function toDecideParams(
  body: SystemOneBody,
  modelId: string
): Extract<DecideParams, { state: unknown }> {
  return {
    modelId,
    state: body.state,
    questions: Object.fromEntries(
      Object.entries(body.questions).map(([id, { option_order, ...question }]) => [
        id,
        { ...question, ...(option_order === undefined ? {} : { optionOrder: option_order }) }
      ])
    ),
    ...(body.max_len === undefined ? {} : { maxLen: body.max_len }),
    ...(body.head_max_len === undefined ? {} : { headMaxLen: body.head_max_len })
  }
}

export function toSystemOneResult(result: DecisionResult, model: string): SystemOneResult {
  const { usage } = result
  return {
    model,
    answers: Object.fromEntries(
      Object.entries(result.answers).map(([id, { answerConfidence, action, ...answer }]) => [
        id,
        {
          ...answer,
          answer_confidence: answerConfidence,
          action: { act_probability: action.actProbability }
        }
      ])
    ),
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      state_tokens: usage.stateTokens,
      state_tokens_dropped: usage.stateTokensDropped,
      truncated: usage.truncated,
      truncated_questions: usage.truncatedQuestions,
      ...(usage.options === undefined
        ? {}
        : {
            options: Object.fromEntries(
              Object.entries(usage.options).map(([id, option]) => [
                id,
                {
                  total: option.total,
                  distinct: option.distinct,
                  tokens_per_option: option.tokensPerOption
                }
              ])
            )
          })
    }
  }
}
