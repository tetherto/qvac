import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { DecisionResult } from '@qvac/sdk'
import { serializerCompiler } from 'fastify-type-provider-zod'
import { decisionsBody, decisionsResult } from '@/serve/extensions/openai/schemas/decisions'
import { toDecideParams, toDecisionsResult } from '@/serve/extensions/openai/adapters/decisions'

const questions = [
  { type: 'predicate', instructions: 'Urgent?' },
  {
    type: 'choice',
    name: 'same',
    instructions: 'Which?',
    choices: [
      { value: true, description: 'Boolean' },
      { value: 'true', description: 'String' },
      { value: '__proto__' },
      { value: 'constructor' }
    ]
  },
  {
    type: 'score',
    name: 'same',
    instructions: 'Severity?',
    levels: [
      { label: 'Low', description: 'Cosmetic' },
      { label: 'High', description: 'Blocked' }
    ]
  }
]
const payload = { model: ' laya ', input: 'Ticket', questions }
const body = decisionsBody.parse(payload)
const base = { answerConfidence: 0.9, confidence: 0.6, action: { actProbability: 0.1 } }
const result: DecisionResult = {
  model: 'checkpoint',
  answers: {
    question_0: { ...base, type: 'noul', noul: 0.95 },
    question_1: {
      ...base,
      type: 'choice',
      choice: 'option_1',
      probabilities: { option_0: 0.1, option_1: 0.7, option_2: 0.1, option_3: 0.1 }
    },
    question_2: {
      ...base,
      type: 'score',
      score: 0.8,
      legend: { '0': 'unused', '1': 'unused' },
      probabilities: { '0': 0.2, '1': 0.8 }
    }
  },
  usage: {
    inputTokens: 42,
    outputTokens: 3,
    stateTokens: 12,
    stateTokensDropped: 2,
    truncated: true,
    truncatedQuestions: ['question_2']
  }
}

describe('OpenAI Decisions adapter', () => {
  it('maps predicates, typed choices, and score descriptions without using names as IDs', () => {
    assert.equal(body.model, 'laya')
    assert.deepEqual(toDecideParams(body, 'sdk-model'), {
      modelId: 'sdk-model',
      state: 'Ticket',
      questions: {
        question_0: { type: 'noul', instructions: 'Urgent?' },
        question_1: {
          type: 'choice',
          instructions: 'Which?',
          criteria: {
            option_0: 'true: Boolean',
            option_1: '"true": String',
            option_2: '"__proto__"',
            option_3: '"constructor"'
          }
        },
        question_2: {
          type: 'score',
          instructions: 'Severity?',
          criteria: ['Low: Cosmetic', 'High: Blocked']
        }
      }
    })
    assert.deepEqual(body.questions, questions)
  })

  it('serializes ordered answers with typed values and OpenAI token usage', () => {
    const expected = {
      model: 'served-alias',
      answers: [
        { type: 'predicate', name: null, probability: 0.95 },
        {
          type: 'choice',
          name: 'same',
          choice: 'true',
          confidence: 0.6,
          probabilities: [
            { value: true, probability: 0.1 },
            { value: 'true', probability: 0.7 },
            { value: '__proto__', probability: 0.1 },
            { value: 'constructor', probability: 0.1 }
          ]
        },
        {
          type: 'score',
          name: 'same',
          score: 0.8,
          confidence: 0.6,
          probabilities: [
            { value: 0, label: 'Low', probability: 0.2 },
            { value: 1, label: 'High', probability: 0.8 }
          ]
        }
      ],
      usage: {
        input_tokens: 42,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 3,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 45
      }
    }
    const mapped = toDecisionsResult(result, body, 'served-alias')
    assert.deepEqual(mapped, expected)
    assert.deepEqual(decisionsResult.parse(mapped), expected)
    const serialize = serializerCompiler({
      schema: decisionsResult,
      method: 'POST',
      url: '/v1/decisions',
      httpStatus: '200'
    })
    assert.deepEqual(JSON.parse(serialize(mapped)), expected)
    const choice = {
      ...base,
      type: 'choice' as const,
      choice: 'option_0',
      probabilities: { option_0: 0.7, option_1: 0.1, option_2: 0.1, option_3: 0.1 }
    }
    const booleanResult = toDecisionsResult(
      { ...result, answers: { ...result.answers, question_1: choice } },
      body,
      'alias'
    )
    assert.equal((booleanResult.answers[1] as { choice: unknown }).choice, true)
  })

  it('preserves text conversations and tool evidence, normalizing system to developer', () => {
    const input = [
      { role: 'system', content: [{ type: 'input_text', text: 'Policy' }] },
      { role: 'user', content: 'Ticket' },
      {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [
          { type: 'output_text', text: 'Checking' },
          { type: 'refusal', refusal: 'Cannot answer' }
        ]
      },
      { type: 'function_call', call_id: 'f', name: 'lookup', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'f',
        output: [{ type: 'input_text', text: 'Found' }]
      },
      { type: 'custom_tool_call', call_id: 'c', name: 'search', input: 'Ticket' },
      { type: 'custom_tool_call_output', call_id: 'c', output: 'Found' }
    ]
    const parsed = decisionsBody.parse({
      ...payload,
      input,
      safety_identifier: null,
      prompt_cache_key: 'tenant-example',
      prompt_cache_options: null
    })
    const params = toDecideParams(parsed, 'sdk-model')
    assert.deepEqual(params.state, [{ ...input[0], role: 'developer' }, ...input.slice(1)])
    assert.equal('safety_identifier' in params, false)
    assert.equal('prompt_cache_key' in params, false)
  })

  it('validates question limits, uniqueness, roles, tools, and unsupported inputs', () => {
    for (const invalid of [
      { input: 42 },
      { input: {} },
      { input: [] },
      { input: null },
      { state: 'Ticket' },
      { stream: true },
      { max_len: 128 },
      { head_max_len: 128 },
      { questions: {} },
      { questions: [] },
      { questions: Array(201).fill(questions[0]) },
      { questions: [{ ...questions[0], instructions: '' }] },
      { questions: [{ ...questions[0], instructions: {} }] },
      { questions: [{ ...questions[0], type: 'noul' }] },
      { questions: [{ ...questions[1], choices: [{ value: 1 }, { value: 2 }] }] },
      { questions: [{ ...questions[1], choices: [{ value: true }, { value: true }] }] },
      { questions: [{ ...questions[1], choices: [{ value: 'a' }] }] },
      {
        questions: [
          {
            ...questions[1],
            choices: Array.from({ length: 256 }, (_, value) => ({ value: String(value) }))
          }
        ]
      },
      { questions: [{ ...questions[2], levels: [{ label: 'Only' }] }] },
      { questions: [{ ...questions[0], option_order: [1, 0] }] },
      {
        input: [
          {
            role: 'user',
            content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }]
          }
        ]
      },
      { input: [{ role: 'assistant', content: [{ type: 'input_text', text: 'Wrong' }] }] },
      { input: [{ role: 'developer', content: [{ type: 'output_text', text: 'Wrong' }] }] },
      { input: [{ role: 'user', content: 'Text', phase: 'commentary' }] },
      { input: [{ type: 'function_call_output', call_id: 'missing', output: 'Result' }] },
      {
        input: [
          { type: 'function_call', call_id: 'f', name: 'tool', arguments: '{}' },
          { type: 'custom_tool_call_output', call_id: 'f', output: 'Wrong' }
        ]
      },
      { prompt_cache_options: { mode: 'implicit' } },
      {
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Text', prompt_cache_breakpoint: { mode: 'explicit' } }
            ]
          }
        ]
      },
      { safety_identifier: 'a'.repeat(129) },
      { prompt_cache_key: 'a'.repeat(65) }
    ]) {
      assert.equal(
        decisionsBody.safeParse({ ...payload, ...invalid }).success,
        false,
        JSON.stringify(invalid)
      )
    }
    assert.equal(
      decisionsBody.safeParse({ ...payload, questions: Array(200).fill(questions[0]) }).success,
      true
    )
    assert.equal(
      decisionsBody.safeParse({ ...payload, questions: [{ ...questions[0], name: '' }] }).success,
      true
    )
  })

  it('fails on incomplete or incompatible native answers instead of inventing probabilities or refusals', () => {
    assert.throws(
      () => toDecisionsResult({ ...result, answers: {} }, body, 'alias'),
      /missing or incompatible/
    )
    assert.throws(
      () =>
        toDecisionsResult(
          { ...result, answers: { ...result.answers, question_0: result.answers['question_2']! } },
          body,
          'alias'
        ),
      /missing or incompatible/
    )
    const choice = { ...base, type: 'choice' as const, choice: 'option_1', probabilities: {} }
    assert.throws(
      () =>
        toDecisionsResult(
          { ...result, answers: { ...result.answers, question_1: choice } },
          body,
          'alias'
        ),
      /omitted an option/
    )
    assert.throws(
      () =>
        toDecisionsResult(
          {
            ...result,
            answers: { ...result.answers, question_1: { ...choice, choice: 'unknown' } }
          },
          body,
          'alias'
        ),
      /unknown choice/
    )
  })
})
