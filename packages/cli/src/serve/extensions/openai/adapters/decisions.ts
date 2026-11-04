import type { DecideParams, DecisionQuestion, DecisionResult } from '@qvac/sdk'
import type { DecisionsBody, DecisionsResult } from '@/serve/extensions/openai/schemas/decisions'

export type DecideFn = (
  params: Extract<DecideParams, { state: unknown }>
) => Promise<DecisionResult> & { requestId: string }

const questionId = (index: number): string => `question_${index}`

export function toDecideParams(
  body: DecisionsBody,
  modelId: string
): Extract<DecideParams, { state: unknown }> {
  const state =
    typeof body.input === 'string'
      ? body.input
      : body.input.map((item) => {
          if (item.type !== undefined && item.type !== 'message') return item
          return { ...item, role: item.role === 'system' ? 'developer' : item.role }
        })
  return {
    modelId,
    state,
    // Names are metadata, not IDs. Index IDs preserve unnamed and repeated names.
    questions: Object.fromEntries(
      body.questions.map((question, index): [string, DecisionQuestion] => {
        const { instructions } = question
        if (question.type === 'predicate') {
          return [questionId(index), { type: 'noul', instructions }]
        }
        if (question.type === 'choice') {
          return [
            questionId(index),
            {
              type: 'choice',
              instructions,
              criteria: Object.fromEntries(
                choiceOptions(question.choices).map(({ key, description }) => [key, description])
              )
            }
          ]
        }
        return [
          questionId(index),
          {
            type: 'score',
            instructions,
            criteria: question.levels.map(({ label, description }) =>
              description === undefined ? label : `${label}: ${description}`
            )
          }
        ]
      })
    )
  }
}

export function toDecisionsResult(
  result: DecisionResult,
  body: DecisionsBody,
  model: string
): DecisionsResult {
  return {
    model,
    answers: body.questions.map((question, index) => {
      const answer = result.answers[questionId(index)]
      const name = question.name ?? null
      if (question.type === 'predicate' && answer?.type === 'noul') {
        return { type: 'predicate', name, probability: answer.noul }
      }
      if (question.type === 'choice' && answer?.type === 'choice') {
        const options = choiceOptions(question.choices)
        const selected = options.find(({ key }) => key === answer.choice)
        if (selected === undefined) throw new Error('Decision model returned an unknown choice.')
        return {
          type: 'choice',
          name,
          choice: selected.value,
          confidence: answer.confidence,
          probabilities: options.map(({ key, value }) => ({
            value,
            probability: readProbability(answer.probabilities, key)
          }))
        }
      }
      if (question.type === 'score' && answer?.type === 'score') {
        return {
          type: 'score',
          name,
          score: answer.score,
          confidence: answer.confidence,
          probabilities: question.levels.map(({ label }, value) => ({
            value,
            label,
            probability: readProbability(answer.probabilities, String(value))
          }))
        }
      }
      throw new Error('Decision model returned a missing or incompatible answer.')
    }),
    usage: {
      input_tokens: result.usage.inputTokens,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: result.usage.outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: result.usage.inputTokens + result.usage.outputTokens
    }
  }
}

function choiceOptions(
  choices: Extract<DecisionsBody['questions'][number], { type: 'choice' }>['choices']
) {
  const keys = choices.map(({ value }) => String(value))
  // Use index IDs only when typed values collide as strings, such as true and "true".
  const indexed = new Set(keys).size !== keys.length
  return choices.map(({ value, description }, index) => ({
    key: indexed ? `option_${index}` : String(value),
    value,
    description: indexed
      ? description === undefined
        ? JSON.stringify(value)
        : `${JSON.stringify(value)}: ${description}`
      : (description ?? null)
  }))
}

function readProbability(probabilities: Record<string, number>, key: string): number {
  const value = probabilities[key]
  if (value === undefined) throw new Error('Decision model omitted an option probability.')
  return value
}
