import type { TestDefinition } from '@qvac/test-suite'
import type { DecideParams, DecisionResult } from '@qvac/sdk'

export type DecisionSingleParams = Omit<Extract<DecideParams, { state: unknown }>, 'modelId'>
export type DecisionBatchParams = Omit<Extract<DecideParams, { states: unknown }>, 'modelId'>
export type DecisionInvalidBudgetParams = {
  invalid: DecisionSingleParams
  recovery: DecisionSingleParams
}

type DecisionTestDefinition = Omit<TestDefinition, 'params'> &
  (
    | { testId: 'decision-ticket'; params: DecisionSingleParams }
    | {
        testId: 'decision-concurrent-queued' | 'decision-structured-batch'
        params: DecisionBatchParams
      }
    | { testId: 'decision-invalid-budget'; params: DecisionInvalidBudgetParams }
  )

const questions: DecisionSingleParams['questions'] = {
  department: {
    type: 'choice',
    instructions: 'Which team should handle this ticket?',
    criteria: ['billing', 'technical']
  },
  urgency: {
    type: 'score',
    instructions: 'How urgent is this?',
    criteria: ['not urgent', 'somewhat urgent', 'very urgent']
  },
  refund: { type: 'noul', instructions: 'The customer asks for a refund.' }
}
const state = 'My payment failed twice and I was charged both times. Please refund the duplicate.'

export const decisionTests = [
  {
    testId: 'decision-concurrent-queued',
    params: {
      states: [state, 'The app crashes on startup.'],
      questions
    },
    expectation: {
      validation: 'contains-all',
      contains: ['billing, technical']
    },
    metadata: { category: 'decision', dependency: 'decision', estimatedDurationMs: 60000 }
  },
  {
    testId: 'decision-ticket',
    params: { state, questions },
    expectation: {
      validation: 'function',
      fn: (value: unknown) => {
        const result = value as DecisionResult
        const team = result.answers['department']
        const urgency = result.answers['urgency']
        const refund = result.answers['refund']
        const passed =
          team?.type === 'choice' &&
          team.choice === 'billing' &&
          (team.probabilities['billing'] ?? 0) > 0.5 &&
          urgency?.type === 'score' &&
          urgency.score >= 0 &&
          urgency.score <= 2 &&
          refund?.type === 'noul' &&
          refund.noul > 0.5 &&
          refund.noul <= 1 &&
          result.usage.inputTokens > 0
        return { passed, output: JSON.stringify(result.answers) }
      }
    },
    metadata: { category: 'decision', dependency: 'decision', estimatedDurationMs: 60000 }
  },
  {
    testId: 'decision-structured-batch',
    params: {
      states: [
        { message: 'The app crashes on startup.' },
        [{ role: 'user', content: "Please send me last month's invoice." }]
      ],
      questions
    },
    expectation: {
      validation: 'function',
      fn: (value: unknown) => {
        const results = value as DecisionResult[]
        const first = results[0]?.answers['department']
        const second = results[1]?.answers['department']
        return {
          passed:
            results.length === 2 &&
            first?.type === 'choice' &&
            first.choice === 'technical' &&
            second?.type === 'choice' &&
            second.choice === 'billing',
          output: JSON.stringify(results.map((result) => result.answers))
        }
      }
    },
    metadata: { category: 'decision', dependency: 'decision', estimatedDurationMs: 60000 }
  },
  {
    testId: 'decision-invalid-budget',
    params: {
      invalid: { state, questions, maxLen: -1 },
      recovery: { state, questions }
    },
    expectation: {
      validation: 'contains-all',
      contains: ['rejected invalid budget', 'recovered billing']
    },
    metadata: { category: 'decision', dependency: 'decision', estimatedDurationMs: 60000 }
  }
] satisfies DecisionTestDefinition[]
