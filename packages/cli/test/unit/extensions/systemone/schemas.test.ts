import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { DecideParams, LayaResult } from '@qvac/sdk'
import { serializerCompiler } from 'fastify-type-provider-zod'
import { systemOneBody, systemOneResult } from '@/serve/extensions/systemone/schemas'

const questions = {
  route: {
    type: 'choice' as const,
    instructions: { task: 'Choose a queue', context: null },
    criteria: { billing: 'Payments', technical: ['Software', null] },
    option_order: [1, 0]
  },
  severity: {
    type: 'score' as const,
    instructions: 'How severe?',
    criteria: ['Minor', { severity: 1 }]
  },
  urgent: {
    type: 'noul' as const,
    instructions: 'Needs a human?',
    criteria: { true: 'Urgent', false: null },
    labels: { false: 'No', true: 'Yes' }
  }
}

describe('System One schemas', () => {
  it('preserves SDK question options and accepts structured and scalar states', () => {
    for (const state of ['Ticket', 42, false, { ticket: ['Refund', null] }, ['Refund', null]]) {
      const parsed = systemOneBody.parse({
        model: ' laya ',
        state,
        questions,
        max_len: 512,
        head_max_len: 128
      })
      assert.equal(parsed.model, 'laya')
      assert.deepEqual(parsed.state, state)
      assert.deepEqual(parsed.questions, questions)
      const { model, ...input } = parsed
      const params: DecideParams = { modelId: model, ...input }
      assert.equal(params.max_len, 512)
      assert.equal(params.head_max_len, 128)
    }
  })

  it('rejects non-JSON state values and invalid question options', () => {
    const valid = { model: 'laya', state: 'Ticket', questions }
    for (const payload of [
      { ...valid, state: null },
      { ...valid, state: { missing: undefined } },
      { ...valid, state: [Infinity] },
      { ...valid, states: ['Ticket'] },
      { ...valid, stream: true },
      { ...valid, max_len: 0 },
      { ...valid, head_max_len: 1.5 },
      { ...valid, questions: { q: { ...questions.route, option_order: [-1] } } },
      { ...valid, questions: { q: { ...questions.urgent, labels: { true: 'Yes' } } } },
      { ...valid, questions: { q: { ...questions.severity, instructions: '' } } },
      { ...valid, questions: { q: { ...questions.route, extra: true } } }
    ]) {
      assert.equal(systemOneBody.safeParse(payload).success, false)
    }
  })

  it('serializes the complete SDK result including optional usage data', () => {
    const base = {
      answer_confidence: 0.9,
      confidence: 0.8,
      action: { act_probability: 0.7 }
    }
    const result: LayaResult = {
      model: 'laya',
      answers: {
        route: { ...base, type: 'choice', choice: 'billing', probabilities: { billing: 0.9 } },
        severity: {
          ...base,
          type: 'score',
          score: 0.8,
          legend: { '0': 'Minor', '1': 'Major' },
          probabilities: { '0': 0.2, '1': 0.8 }
        },
        urgent: { ...base, type: 'noul', noul: 0.7 }
      },
      usage: {
        input_tokens: 42,
        output_tokens: 0,
        state_tokens: 12,
        state_tokens_dropped: 2,
        truncated: true,
        truncated_questions: ['severity'],
        options: { route: { total: 2, distinct: 2, tokens_per_option: null } }
      }
    }
    const parsed: LayaResult = systemOneResult.parse(result)
    assert.deepEqual(parsed, result)
    const serialize = serializerCompiler({
      schema: systemOneResult,
      method: 'POST',
      url: '/v1/systemone',
      httpStatus: '200'
    })
    assert.deepEqual(JSON.parse(serialize(result)), result)
  })
})
