import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { DecisionResult } from '@qvac/sdk'
import { serializerCompiler } from 'fastify-type-provider-zod'
import {
  systemOneBody,
  systemOneResult,
  type SystemOneResult
} from '@/serve/extensions/systemone/schemas'
import { toDecideParams, toSystemOneResult } from '@/serve/extensions/systemone/mapping'

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
  it('omits absent optional fields when converting requests and results', () => {
    assert.deepEqual(
      toDecideParams(
        systemOneBody.parse({
          model: 'laya',
          state: 'Ticket',
          questions: { urgent: { type: 'noul', instructions: 'Urgent?' } }
        }),
        'sdk-model-id'
      ),
      {
        modelId: 'sdk-model-id',
        state: 'Ticket',
        questions: { urgent: { type: 'noul', instructions: 'Urgent?' } }
      }
    )
    assert.deepEqual(
      toSystemOneResult(
        {
          model: 'checkpoint',
          answers: {},
          usage: {
            inputTokens: 1,
            outputTokens: 0,
            stateTokens: 1,
            stateTokensDropped: 0,
            truncated: false,
            truncatedQuestions: []
          }
        },
        'laya'
      ),
      {
        model: 'laya',
        answers: {},
        usage: {
          input_tokens: 1,
          output_tokens: 0,
          state_tokens: 1,
          state_tokens_dropped: 0,
          truncated: false,
          truncated_questions: []
        }
      }
    )
  })
  it('maps HTTP question options and structured or scalar states to SDK parameters', () => {
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
      assert.deepEqual(toDecideParams(parsed, 'sdk-model-id'), {
        modelId: 'sdk-model-id',
        state,
        questions: {
          ...questions,
          route: {
            type: 'choice',
            instructions: { task: 'Choose a queue', context: null },
            criteria: { billing: 'Payments', technical: ['Software', null] },
            optionOrder: [1, 0]
          }
        },
        maxLen: 512,
        headMaxLen: 128
      })
      assert.deepEqual(parsed.questions, questions)
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
      { ...valid, maxLen: 512 },
      { ...valid, headMaxLen: 128 },
      { ...valid, questions: { q: { ...questions.route, optionOrder: [1, 0] } } },
      { ...valid, questions: { q: { ...questions.route, option_order: [-1] } } },
      { ...valid, questions: { q: { ...questions.urgent, labels: { true: 'Yes' } } } },
      { ...valid, questions: { q: { ...questions.severity, instructions: '' } } },
      { ...valid, questions: { q: { ...questions.route, extra: true } } }
    ]) {
      assert.equal(systemOneBody.safeParse(payload).success, false)
    }
  })

  it('serializes the complete HTTP result including optional usage data', () => {
    const base = {
      answerConfidence: 0.9,
      confidence: 0.8,
      action: { actProbability: 0.7 }
    }
    const result: DecisionResult = {
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
        inputTokens: 42,
        outputTokens: 0,
        stateTokens: 12,
        stateTokensDropped: 2,
        truncated: true,
        truncatedQuestions: ['severity'],
        options: { route: { total: 2, distinct: 2, tokensPerOption: null } }
      }
    }
    const httpBase = {
      answer_confidence: 0.9,
      confidence: 0.8,
      action: { act_probability: 0.7 }
    }
    const expected: SystemOneResult = {
      model: 'served-alias',
      answers: {
        route: { ...httpBase, type: 'choice', choice: 'billing', probabilities: { billing: 0.9 } },
        severity: {
          ...httpBase,
          type: 'score',
          score: 0.8,
          legend: { '0': 'Minor', '1': 'Major' },
          probabilities: { '0': 0.2, '1': 0.8 }
        },
        urgent: { ...httpBase, type: 'noul', noul: 0.7 }
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
    const mapped = toSystemOneResult(result, 'served-alias')
    assert.deepEqual(mapped, expected)
    assert.deepEqual(systemOneResult.parse(mapped), expected)
    const serialize = serializerCompiler({
      schema: systemOneResult,
      method: 'POST',
      url: '/v1/systemone',
      httpStatus: '200'
    })
    assert.deepEqual(JSON.parse(serialize(mapped)), expected)
  })
})
