import type {
  LayaConfig,
  LayaQuestion as NativeLayaQuestion,
  LayaRequest as NativeLayaRequest,
  LayaResult as NativeLayaResult
} from '@qvac/embed-llamacpp'
import type {
  DecisionConfig,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult
} from '@/schemas/index'
import { toNativeEmbedLlamacppConfig } from '@/plugins/ops/embed-llamacpp-config'

export function transformDecisionConfig(config: DecisionConfig): LayaConfig {
  return { ...toNativeEmbedLlamacppConfig(config), device: config.device }
}

function transformDecisionQuestion(question: DecisionQuestion): NativeLayaQuestion {
  const base = {
    instructions: question.instructions,
    ...(question.optionOrder === undefined ? {} : { option_order: question.optionOrder })
  }
  if (question.type === 'choice') {
    return { ...base, type: 'choice', criteria: question.criteria }
  }
  if (question.type === 'score') {
    return { ...base, type: 'score', criteria: question.criteria }
  }
  const criteria = question.criteria
  return {
    ...base,
    type: 'noul',
    ...(criteria === undefined
      ? {}
      : {
          criteria:
            criteria === null
              ? null
              : {
                  ...(criteria.true === undefined ? {} : { true: criteria.true }),
                  ...(criteria.false === undefined ? {} : { false: criteria.false })
                }
        }),
    ...(question.labels === undefined ? {} : { labels: question.labels })
  }
}

export function transformDecisionRequest(request: DecisionRequest): NativeLayaRequest {
  return {
    ...('states' in request ? { states: request.states } : { state: request.state }),
    questions: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [
        id,
        transformDecisionQuestion(question)
      ])
    ),
    ...(request.maxLen === undefined ? {} : { max_len: request.maxLen }),
    ...(request.headMaxLen === undefined ? {} : { head_max_len: request.headMaxLen })
  }
}

export function transformDecisionResult(result: NativeLayaResult): DecisionResult {
  const { usage } = result
  return {
    model: result.model,
    answers: Object.fromEntries(
      Object.entries(result.answers).map(([id, answer]) => {
        const { answer_confidence, action, ...fields } = answer
        return [
          id,
          {
            ...fields,
            answerConfidence: answer_confidence,
            action: { actProbability: action.act_probability }
          }
        ]
      })
    ),
    usage: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      stateTokens: usage.state_tokens,
      stateTokensDropped: usage.state_tokens_dropped,
      truncated: usage.truncated,
      truncatedQuestions: usage.truncated_questions,
      ...(usage.options === undefined
        ? {}
        : {
            options: Object.fromEntries(
              Object.entries(usage.options).map(([id, option]) => [
                id,
                {
                  total: option.total,
                  distinct: option.distinct,
                  tokensPerOption: option.tokens_per_option
                }
              ])
            )
          })
    }
  }
}
