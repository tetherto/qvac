import assert from 'node:assert/strict'
import test from 'node:test'
import { decisionTests } from '../../sdk-e2e/catalog/decision-tests'
import { RESOURCE_TABLE } from '../../sdk-e2e/catalog/resource-table'

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
    usage: {
      inputTokens: 30,
      outputTokens: 0,
      stateTokens: 10,
      stateTokensDropped: 0,
      truncated: false,
      truncatedQuestions: [] as string[]
    }
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
  for (const testId of [
    'decision-structured-batch',
    'decision-structured-batch-parity',
    'decision-concurrent-queued'
  ]) {
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

test('GPU batch accepts the observed CI drift while CPU parity keeps its tolerance', () => {
  const reference = [result(0.2), result(0.8)]
  const actual = structuredClone(reference)
  reference[0].answers.urgency.probabilities = { 0: 0.0312, 1: 0.4961, 2: 0.4727 }
  reference[0].answers.urgency.score = 1.4415
  actual[0].answers.urgency.probabilities = { 0: 0.0311, 1: 0.4891, 2: 0.4799 }
  actual[0].answers.urgency.score = 1.4488

  assert.equal(validate('decision-structured-batch', actual, reference), true)
  assert.equal(validate('decision-structured-batch-parity', actual, reference), false)
  assert.equal(validate('decision-structured-batch-parity', reference), true)
})

test('CPU parity uses the same inputs and model with a fixed forward-pass size', () => {
  const batch = decisionTests.find(
    (definition) => definition.testId === 'decision-structured-batch'
  )!
  const parity = decisionTests.find(
    (definition) => definition.testId === 'decision-structured-batch-parity'
  )!
  assert.deepEqual(parity.params, batch.params)
  assert.equal(batch.metadata.dependency, 'decision')
  assert.equal(parity.metadata.dependency, 'decision-parity')
  assert.deepEqual(RESOURCE_TABLE['decision-parity'].constant, RESOURCE_TABLE.decision.constant)
  assert.deepEqual(RESOURCE_TABLE['decision-parity'].config, {
    device: 'cpu',
    flash_attn: 'off',
    batch_size: 64
  })
  assert.equal(RESOURCE_TABLE.decision.config, undefined)
})

test('GPU batch still rejects changed usage, legends, choices, and duplicated results', () => {
  const reference = [result(0.2), result(0.8)]
  const mutations = [
    (values: ReturnType<typeof result>[]) => {
      values[0].usage.stateTokens += 1
    },
    (values: ReturnType<typeof result>[]) => {
      values[0].answers.urgency.legend[0] = 'urgent'
    },
    (values: ReturnType<typeof result>[]) => {
      values[0].answers.department = result(0.8).answers.department
    },
    (values: ReturnType<typeof result>[]) => {
      values[1] = structuredClone(values[0])
    }
  ]
  for (const mutate of mutations) {
    const actual = structuredClone(reference)
    mutate(actual)
    assert.equal(validate('decision-structured-batch', actual, reference), false)
  }
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
    assert.equal(validate('decision-structured-batch', [invalid, result()]), false)
    assert.equal(validate('decision-structured-batch-parity', [invalid, result()]), false)
  })
}
