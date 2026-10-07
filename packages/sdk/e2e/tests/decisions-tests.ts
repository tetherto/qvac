import type { TestDefinition } from '@qvac/test-suite'
import type { LayaResult } from '@qvac/sdk'

export const decisionsTests: TestDefinition[] = [
  {
    testId: 'decisions-ticket',
    params: {},
    expectation: {
      validation: 'function',
      fn: (value: unknown) => {
        const result = value as LayaResult
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
          result.usage.input_tokens > 0
        return { passed, output: JSON.stringify(result.answers) }
      }
    },
    metadata: { category: 'decisions', dependency: 'decisions', estimatedDurationMs: 60000 }
  },
  {
    testId: 'decisions-structured-batch',
    params: {},
    expectation: {
      validation: 'function',
      fn: (value: unknown) => {
        const results = value as LayaResult[]
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
    metadata: { category: 'decisions', dependency: 'decisions', estimatedDurationMs: 60000 }
  },
  {
    testId: 'decisions-invalid-budget',
    params: {},
    expectation: {
      validation: 'contains-all',
      contains: ['rejected invalid budget', 'recovered billing']
    },
    metadata: { category: 'decisions', dependency: 'decisions', estimatedDurationMs: 60000 }
  }
]
