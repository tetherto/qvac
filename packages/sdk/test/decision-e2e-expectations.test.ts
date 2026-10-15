import assert from 'node:assert/strict'
import test from 'node:test'
import { decisionTests } from '../e2e/tests/decision-tests'

function result(billing = 0.2, noul = 0.3) {
  const base = { confidence: 0.2, answerConfidence: 0.8, action: { actProbability: 0.5 } }
  return {
    model: 'test-checkpoint',
    answers: {
      department: {
        ...base,
        type: 'choice',
        choice: billing > 0.5 ? 'billing' : 'technical',
        answerConfidence: Math.max(billing, 1 - billing),
        probabilities: { billing, technical: 1 - billing }
      },
      urgency: {
        ...base,
        type: 'score',
        score: 1.3,
        probabilities: { 0: 0.2, 1: 0.3, 2: 0.5 },
        legend: { 0: 'not urgent', 1: 'somewhat urgent', 2: 'very urgent' }
      },
      refund: { ...base, type: 'noul', noul }
    },
    usage: { inputTokens: 30 }
  }
}

function validate(
  testId: string,
  results: ReturnType<typeof result>[],
  reference = structuredClone(results)
): boolean {
  const definition = decisionTests.find((definition) => definition.testId === testId)
  assert.ok(definition, `Missing decision test: ${testId}`)
  const expectation = definition.expectation
  assert.ok(expectation.validation === 'function')
  return expectation.fn({ results, reference }).passed
}

test('every decision test accepts consistent answers regardless of their classification', () => {
  for (const definition of decisionTests) {
    const count = 'states' in definition.params ? definition.params.states.length : 1
    assert.equal(
      validate(
        definition.testId,
        Array.from({ length: count }, () => result())
      ),
      true
    )
  }
})

test('batch and concurrent tests reject swapped or missing results', () => {
  for (const testId of ['decision-structured-batch', 'decision-concurrent-queued']) {
    const reference = [result(0.2), result(0.8)]
    assert.equal(validate(testId, [...reference].reverse(), reference), false)
    assert.equal(validate(testId, [reference[0]], reference), false)
  }
})

test('recovery and repeat tests reject changed answers', () => {
  for (const testId of ['decision-invalid-budget', 'decision-ticket']) {
    assert.equal(validate(testId, [result(0.8)], [result(0.2)]), false)
    assert.equal(validate(testId, [result(0.2, 0.9)], [result(0.2, 0.3)]), false)
  }
})

test('small numerical differences and near-tied choices are tolerated', () => {
  const reference = result(0.5001)
  const actual = result(0.4999)
  actual.answers.refund.noul += 0.0001
  assert.equal(validate('decision-ticket', [actual], [reference]), true)
})

const invalidResults: Record<string, (value: ReturnType<typeof result>) => void> = {
  'missing question': (value) => {
    Reflect.deleteProperty(value.answers, 'refund')
  },
  'unknown choice': (value) => {
    value.answers.department.choice = 'sales'
  },
  'choice disagrees with probabilities': (value) => {
    value.answers.department.choice = 'billing'
  },
  'choice confidence disagrees with probabilities': (value) => {
    value.answers.department.answerConfidence = 0.1
  },
  'unnormalized probabilities': (value) => {
    value.answers.department.probabilities.technical = 0.4
  },
  'missing score level': (value) => {
    Reflect.deleteProperty(value.answers.urgency.probabilities, '0')
  },
  'score disagrees with probabilities': (value) => {
    value.answers.urgency.score = 0.5
  },
  'missing legend level': (value) => {
    Reflect.deleteProperty(value.answers.urgency.legend, '0')
  },
  'non-finite probability': (value) => {
    value.answers.refund.noul = NaN
  },
  'out-of-range probability': (value) => {
    value.answers.refund.noul = 1.1
  },
  'empty token usage': (value) => {
    value.usage.inputTokens = 0
  }
}

for (const [name, mutate] of Object.entries(invalidResults)) {
  test(`rejects ${name} even when both calls return it`, () => {
    const invalid = result()
    mutate(invalid)
    assert.equal(validate('decision-ticket', [invalid]), false)
  })
}
