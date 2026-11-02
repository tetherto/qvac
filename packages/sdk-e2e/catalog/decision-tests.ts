import type { Expectation, TestDefinition } from '@qvac/test-suite'
import type { DecisionBatchRequest, DecisionResult, DecisionSingleRequest } from './wire-types.js'

export type DecisionSingleParams = DecisionSingleRequest
export type DecisionBatchParams = DecisionBatchRequest
export type DecisionInvalidBudgetParams = {
  invalid: DecisionSingleParams
  recovery: DecisionSingleParams
}

type DecisionTestDefinition = Omit<TestDefinition, 'params'> &
  (
    | { testId: 'decision-ticket'; params: DecisionSingleParams }
    | {
        testId:
          | 'decision-concurrent-queued'
          | 'decision-structured-batch'
          | 'decision-structured-batch-parity'
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
const structuredBatch: DecisionBatchParams = {
  states: [
    { message: 'The app crashes on startup.' },
    [{ role: 'user', content: "Please send me last month's invoice." }]
  ],
  questions
}

export type DecisionComparison = { results: DecisionResult[]; reference: DecisionResult[] }

// Check SDK behavior on the same device without assuming a particular classification.
const tolerance = 1e-3
const isProbability = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1
const close = (left: number, right: number) => Math.abs(left - right) <= tolerance

function validDistribution(probabilities: Record<string, number>, keys: string[]): boolean {
  return (
    Object.keys(probabilities).length === keys.length &&
    keys.every((key) => isProbability(probabilities[key])) &&
    close(
      Object.values(probabilities).reduce((sum, value) => sum + value, 0),
      1
    )
  )
}

function validDecision(result: DecisionResult): boolean {
  const { department, urgency, refund } = result.answers
  return (
    Object.keys(result.answers).sort().join(',') === 'department,refund,urgency' &&
    department?.type === 'choice' &&
    ['billing', 'technical'].includes(String(department.choice)) &&
    validDistribution(department.probabilities, ['billing', 'technical']) &&
    close(
      department.probabilities[String(department.choice)],
      Math.max(...Object.values(department.probabilities))
    ) &&
    close(department.answerConfidence, department.probabilities[String(department.choice)]) &&
    urgency?.type === 'score' &&
    validDistribution(urgency.probabilities, ['0', '1', '2']) &&
    Object.keys(urgency.legend).sort().join(',') === '0,1,2' &&
    urgency.score >= 0 &&
    urgency.score <= 2 &&
    close(urgency.score, urgency.probabilities['1'] + 2 * urgency.probabilities['2']) &&
    refund?.type === 'noul' &&
    isProbability(refund.noul) &&
    Object.values(result.answers).every(
      (answer) =>
        isProbability(answer.confidence) &&
        isProbability(answer.answerConfidence) &&
        isProbability(answer.action.actProbability)
    ) &&
    result.usage.inputTokens > 0
  )
}

function decisionExpectation(count: number, compareNumbers = true): Expectation {
  return {
    validation: 'function',
    fn: (value: unknown) => {
      const { results, reference } = value as DecisionComparison
      const passed =
        results.length === count &&
        reference.length === count &&
        [...results, ...reference].every(validDecision) &&
        results.every((result, index) => {
          const expected = reference[index]
          return (
            result.model === expected.model &&
            result.usage.inputTokens === expected.usage.inputTokens &&
            result.usage.outputTokens === expected.usage.outputTokens &&
            result.usage.stateTokens === expected.usage.stateTokens &&
            result.usage.stateTokensDropped === expected.usage.stateTokensDropped &&
            result.usage.truncated === expected.usage.truncated &&
            result.usage.truncatedQuestions.length === expected.usage.truncatedQuestions.length &&
            result.usage.truncatedQuestions.every(
              (id, index) => id === expected.usage.truncatedQuestions[index]
            ) &&
            Object.entries(result.answers).every(([id, answer]) => {
              const other = expected.answers[id]
              if (answer.type !== other.type) return false
              if (
                !compareNumbers &&
                answer.type === 'choice' &&
                other.type === 'choice' &&
                answer.choice !== other.choice
              ) {
                return false
              }
              if (
                answer.type === 'score' &&
                other.type === 'score' &&
                Object.keys(answer.legend).some((key) => answer.legend[key] !== other.legend[key])
              ) {
                return false
              }
              // Packed forward passes can round differently from individual calls.
              if (!compareNumbers) return true
              if (answer.type === 'noul') {
                return other.type === 'noul' && close(answer.noul, other.noul)
              }
              if (other.type === 'noul') return false
              return (
                Object.keys(answer.probabilities).every((key) =>
                  close(answer.probabilities[key], other.probabilities[key])
                ) &&
                (answer.type !== 'score' ||
                  (other.type === 'score' && close(answer.score, other.score)))
              )
            })
          )
        })
      return { passed, output: JSON.stringify({ results, reference }) }
    }
  }
}

export const decisionTests = [
  {
    testId: 'decision-concurrent-queued',
    params: {
      states: [state, 'The app crashes on startup.'],
      questions
    },
    expectation: decisionExpectation(2),
    metadata: { category: 'decision', dependency: 'decision', estimatedDurationMs: 60000 }
  },
  {
    testId: 'decision-ticket',
    params: { state, questions },
    suites: ['smoke'],
    expectation: decisionExpectation(1),
    metadata: { category: 'decision', dependency: 'decision', estimatedDurationMs: 60000 }
  },
  {
    testId: 'decision-structured-batch',
    params: structuredBatch,
    expectation: decisionExpectation(2, false),
    metadata: { category: 'decision', dependency: 'decision', estimatedDurationMs: 60000 }
  },
  {
    testId: 'decision-structured-batch-parity',
    params: structuredBatch,
    expectation: decisionExpectation(2),
    metadata: { category: 'decision', dependency: 'decision-parity', estimatedDurationMs: 60000 }
  },
  {
    testId: 'decision-invalid-budget',
    params: {
      invalid: { state, questions, maxLen: -1 },
      recovery: { state, questions }
    },
    expectation: decisionExpectation(1),
    metadata: { category: 'decision', dependency: 'decision', estimatedDurationMs: 60000 }
  }
] satisfies DecisionTestDefinition[]
