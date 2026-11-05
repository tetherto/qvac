import { describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  RequestRejectedByPolicyError,
  LAYA_MULTILINGUAL_322M_Q8_0,
  type DecisionResult
} from '@qvac/sdk'
import { buildServer } from '@/serve/index'
import { buildGenericEntry } from '@/configure/presets'
import type { DecideFn } from '@/serve/extensions/openai/adapters/decisions'
import { writeConfigDir } from '../helpers/config.js'

const questions = [
  {
    type: 'choice' as const,
    name: 'route',
    instructions: 'Which queue?',
    choices: [
      { value: 'billing', description: 'Payments' },
      { value: 'technical', description: 'Bugs' }
    ]
  },
  {
    type: 'score' as const,
    name: 'severity',
    instructions: 'How severe?',
    levels: [{ label: 'Minor' }, { label: 'Major' }]
  },
  { type: 'predicate' as const, name: 'urgent', instructions: 'Does this need a human now?' }
]
const base = { answerConfidence: 0.9, confidence: 0.6, action: { actProbability: 0.1 } }
const result: DecisionResult = {
  model: 'native-checkpoint-name',
  answers: {
    question_0: {
      ...base,
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.9, technical: 0.1 }
    },
    question_1: {
      ...base,
      type: 'score',
      score: 0.8,
      legend: { '0': 'Minor', '1': 'Major' },
      probabilities: { '0': 0.2, '1': 0.8 }
    },
    question_2: { ...base, type: 'noul', noul: 0.7 }
  },
  usage: {
    inputTokens: 42,
    outputTokens: 0,
    stateTokens: 12,
    stateTokensDropped: 0,
    truncated: false,
    truncatedQuestions: [],
    options: { question_0: { total: 2, distinct: 2, tokensPerOption: null } }
  }
}
const httpResult = {
  model: 'native-checkpoint-name',
  answers: [
    {
      type: 'choice',
      name: 'route',
      choice: 'billing',
      confidence: 0.6,
      probabilities: [
        { value: 'billing', probability: 0.9 },
        { value: 'technical', probability: 0.1 }
      ]
    },
    {
      type: 'score',
      name: 'severity',
      score: 0.8,
      confidence: 0.6,
      probabilities: [
        { value: 0, label: 'Minor', probability: 0.2 },
        { value: 1, label: 'Major', probability: 0.8 }
      ]
    },
    { type: 'predicate', name: 'urgent', probability: 0.7 }
  ],
  usage: {
    input_tokens: 42,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 42
  }
}

async function server(
  t: TestContext,
  options: {
    decideOverride?: DecideFn
    apiKey?: string
    lazy?: boolean
    constantModel?: boolean
  } = {}
) {
  const projectRoot = await writeConfigDir(t, {
    serve: {
      load: { lazy: options.lazy ?? true },
      models: {
        laya: options.constantModel
          ? buildGenericEntry(LAYA_MULTILINGUAL_322M_Q8_0.name, LAYA_MULTILINGUAL_322M_Q8_0.addon)
              .entry
          : {
              src: '/models/laya.gguf',
              type: 'llamacpp-decision',
              default: true,
              config: { device: 'cpu' }
            },
        chat: { src: '/models/chat.gguf', type: 'llamacpp-completion' },
        embedding: { src: '/models/embed.gguf', type: 'llamacpp-embedding' }
      }
    }
  })
  const loaded: unknown[] = []
  const app = await buildServer({
    projectRoot,
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    extensions: ['openai'],
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    extensionOptions: { openai: options },
    loadModelOverride: (params) => {
      loaded.push(params)
      return Object.assign(Promise.resolve('sdk-laya-id'), { requestId: 'load-id' })
    }
  })
  t.after(async () => {
    await app.close()
  })
  return { app, loaded }
}

describe('OpenAI Decisions HTTP API', () => {
  it('loads a search-all decision constant without an explicit type override', async (t) => {
    const { app, loaded } = await server(t, {
      constantModel: true,
      decideOverride: () => Object.assign(Promise.resolve(result), { requestId: 'decision-id' })
    })
    const response = await app.inject({
      method: 'POST',
      url: '/v1/decisions',
      payload: { model: 'laya', input: 'Charged twice', questions }
    })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(loaded.length, 1)
    const load = loaded[0] as { modelSrc: unknown; modelType: string }
    assert.equal(load.modelSrc, LAYA_MULTILINGUAL_322M_Q8_0)
    assert.equal(load.modelType, 'llamacpp-decision')
    assert.equal(app.qvac.serveConfig.models.get('laya')?.endpointCategory, 'decision')
    assert.deepEqual(response.json(), { ...httpResult, model: 'laya' })
  })

  it('lazy-loads once, forwards typed questions, and binds cancellation before awaiting', async (t) => {
    const calls: Parameters<DecideFn>[0][] = []
    const bound: string[] = []
    let completeDecision: (value: DecisionResult) => void = () => {}
    let notifyBinding: (id: string) => void = () => {}
    const { app, loaded } = await server(t, {
      decideOverride: (params) => {
        calls.push(params)
        return Object.assign(
          new Promise<DecisionResult>((resolve) => {
            completeDecision = resolve
          }),
          { requestId: 'decision-id' }
        )
      }
    })
    app.addHook('onRequest', (req, _reply, done) => {
      req.bindCancel = (id) => {
        bound.push(id)
        notifyBinding(id)
      }
      done()
    })
    const state = [{ role: 'user', content: 'Charged twice' }]
    for (const model of ['laya', '/models/laya.gguf']) {
      const binding = new Promise<string>((resolve) => {
        notifyBinding = resolve
      })
      const pending = app
        .inject({
          method: 'POST',
          url: '/v1/decisions',
          payload: { model, input: state, questions }
        })
        .then((response) => response)
      assert.equal(await binding, 'decision-id')
      completeDecision(result)
      const response = await pending
      assert.equal(response.statusCode, 200, response.body)
      assert.deepEqual(response.json(), { ...httpResult, model: 'laya' })
      assert.match(response.headers['content-type'] ?? '', /application\/json/)
      assert.deepEqual(calls.at(-1), {
        modelId: 'sdk-laya-id',
        state,
        questions: {
          question_0: {
            type: 'choice',
            instructions: 'Which queue?',
            criteria: { billing: 'Payments', technical: 'Bugs' }
          },
          question_1: { type: 'score', instructions: 'How severe?', criteria: ['Minor', 'Major'] },
          question_2: { type: 'noul', instructions: 'Does this need a human now?' }
        }
      })
    }
    assert.equal(loaded.length, 1)
    assert.deepEqual(bound, ['decision-id', 'decision-id'])
  })

  it('reports a lazy-load failure through the shared error handler', async (t) => {
    const { app } = await server(t)
    app.qvac.loadModelOverride = () => Promise.reject(new Error('checkpoint unavailable'))
    const response = await app.inject({
      method: 'POST',
      url: '/v1/decisions',
      payload: { model: 'laya', input: 'a', questions }
    })
    assert.equal(response.statusCode, 503)
    assert.equal(response.json().error.code, 'model_load_failed')
  })

  it('returns 429 for decision queue overflow without interrupting the active request', async (t) => {
    let completeDecision: (value: DecisionResult) => void = () => {}
    let notifyStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    let active = false
    const busy = new RequestRejectedByPolicyError(
      'decision-busy',
      'decision',
      'sdk-laya-id',
      'maxQueueDepthPerModel exceeded (depth=64, cap=64)'
    )
    const { app } = await server(t, {
      decideOverride: () => {
        if (active) {
          return Object.assign(Promise.reject(busy), { requestId: 'decision-busy' })
        }
        active = true
        return Object.assign(
          new Promise<DecisionResult>((resolve) => {
            completeDecision = resolve
            notifyStarted()
          }).finally(() => {
            active = false
          }),
          { requestId: 'decision-active' }
        )
      }
    })
    const request = {
      method: 'POST' as const,
      url: '/v1/decisions',
      payload: { model: 'laya', input: 'a', questions }
    }
    const first = app.inject(request).then((response) => response)
    await started
    try {
      const second = await app.inject(request)
      assert.equal(second.statusCode, 429, second.body)
      assert.deepEqual(second.json().error, {
        message: busy.message,
        type: 'rate_limit_error',
        code: 'request_rejected_by_policy'
      })
      assert.equal(active, true)
    } finally {
      completeDecision(result)
    }
    const response = await first
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json(), { ...httpResult, model: 'laya' })
  })

  it('rejects malformed requests, batching, and streaming before loading a model', async (t) => {
    const { app, loaded } = await server(t)
    const valid = { model: 'laya', input: 'Charged twice', questions }
    for (const payload of [
      { input: valid.input, questions },
      { ...valid, input: null },
      { model: 'laya', states: ['a', 'b'], questions },
      { ...valid, stream: true },
      { ...valid, questions: [{ type: 'noul', instructions: 'Urgent?' }] },
      { ...valid, max_len: 512 },
      { ...valid, head_max_len: 128 },
      { ...valid, questions: [] },
      {
        ...valid,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_image', image_url: 'https://example.com/image.png' }]
          }
        ]
      },
      { ...valid, prompt_cache_options: { mode: 'explicit' } }
    ]) {
      const response = await app.inject({ method: 'POST', url: '/v1/decisions', payload })
      assert.equal(response.statusCode, 400, response.body)
      assert.equal(response.json().error.type, 'invalid_request_error')
    }
    assert.equal(loaded.length, 0)
  })

  it('explains unsupported image inputs before loading or inference', async (t) => {
    const { app, loaded } = await server(t)
    const response = await app.inject({
      method: 'POST',
      url: '/v1/decisions',
      payload: {
        model: 'laya',
        questions,
        input: [
          {
            role: 'user',
            content: [{ type: 'input_image', image_url: 'https://example.com/photo.png' }]
          }
        ]
      }
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error.code, 'unsupported_input')
    assert.match(response.json().error.message, /do not support image input/)
    assert.equal(loaded.length, 0)
  })

  it('rejects unknown aliases and incompatible models', async (t) => {
    const { app, loaded } = await server(t)
    for (const [model, status, code] of [
      ['missing', 404, 'model_not_found'],
      ['chat', 400, 'invalid_model_type'],
      ['embedding', 400, 'invalid_model_type']
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/decisions',
        payload: { model, input: 'a', questions }
      })
      assert.equal(response.statusCode, status)
      assert.equal(response.json().error.code, code)
    }
    assert.equal(loaded.length, 0)
  })

  it('honors disabled lazy loading', async (t) => {
    const { app, loaded } = await server(t, { lazy: false })
    const response = await app.inject({
      method: 'POST',
      url: '/v1/decisions',
      payload: { model: 'laya', input: 'a', questions }
    })
    assert.equal(response.statusCode, 503)
    assert.equal(response.json().error.code, 'model_not_loaded')
    assert.equal(loaded.length, 0)
  })

  it('requires the configured bearer token', async (t) => {
    const { app, loaded } = await server(t, {
      apiKey: 'test-key',
      decideOverride: () => Object.assign(Promise.resolve(result), { requestId: 'decision-id' })
    })
    const request = {
      method: 'POST' as const,
      url: '/v1/decisions',
      payload: { model: 'laya', input: 'a', questions }
    }
    assert.equal((await app.inject(request)).statusCode, 401)
    assert.equal(loaded.length, 0)
    assert.equal(
      (
        await app.inject({
          ...request,
          headers: { authorization: 'Bearer test-key' }
        })
      ).statusCode,
      200
    )
  })

  it('publishes the decision contract in OpenAPI', async (t) => {
    const { app } = await server(t)
    const response = await app.inject({ method: 'GET', url: '/openapi.json' })
    assert.equal(response.statusCode, 200, response.body)
    const paths = response.json().paths
    assert.ok(paths['/v1/decisions'].post)
    assert.ok(paths['/v1/chat/completions'].post)
    for (const field of [
      'input',
      'questions',
      'answers',
      'predicate',
      'choices',
      'levels',
      'name',
      'probabilities',
      'cache_write_tokens',
      'reasoning_tokens',
      'total_tokens',
      'refusal'
    ]) {
      assert.ok(JSON.stringify(paths['/v1/decisions']).includes(`"${field}"`), field)
    }
    for (const field of [
      'state',
      'max_len',
      'head_max_len',
      'option_order',
      'noul',
      'answer_confidence',
      'act_probability',
      'state_tokens'
    ]) {
      assert.ok(!JSON.stringify(paths['/v1/decisions']).includes(`"${field}"`), field)
    }
  })

  it('accepts an unnamed predicate and the safety identifier', async (t) => {
    const calls: Parameters<DecideFn>[0][] = []
    const { app } = await server(t, {
      decideOverride: (params) => {
        calls.push(params)
        return Object.assign(
          Promise.resolve({ ...result, answers: { question_0: result.answers['question_2']! } }),
          { requestId: 'decision-id' }
        )
      }
    })
    const response = await app.inject({
      method: 'POST',
      url: '/v1/decisions',
      payload: {
        model: 'laya',
        input: 'Help!',
        questions: [{ type: 'predicate', instructions: 'Urgent?' }],
        safety_identifier: 'customer-example'
      }
    })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(calls, [
      {
        modelId: 'sdk-laya-id',
        state: 'Help!',
        questions: { question_0: { type: 'noul', instructions: 'Urgent?' } }
      }
    ])
    assert.deepEqual(response.json(), {
      model: 'laya',
      answers: [{ type: 'predicate', name: null, probability: 0.7 }],
      usage: httpResult.usage
    })
  })

  it('uses shared 400 errors for malformed JSON and questions', async (t) => {
    const { app, loaded } = await server(t)
    const malformedJson = await app.inject({
      method: 'POST',
      url: '/v1/decisions',
      headers: { 'content-type': 'application/json' },
      payload: '{'
    })
    assert.equal(malformedJson.statusCode, 400, malformedJson.body)
    assert.equal(malformedJson.json().error.code, 'invalid_json')
    const malformedQuestion = await app.inject({
      method: 'POST',
      url: '/v1/decisions',
      payload: { model: 'laya', input: 'Ticket', questions: { route: { type: 'choice' } } }
    })
    assert.equal(malformedQuestion.statusCode, 400, malformedQuestion.body)
    assert.equal(malformedQuestion.json().error.code, 'invalid_questions')
    assert.match(malformedQuestion.json().error.message, /questions/)
    assert.equal(loaded.length, 0)
  })

  it('returns a server error when SDK inference fails', async (t) => {
    const { app } = await server(t, {
      decideOverride: () =>
        Object.assign(Promise.reject(new Error('inference failed')), {
          requestId: 'decision-id'
        })
    })
    const response = await app.inject({
      method: 'POST',
      url: '/v1/decisions',
      payload: { model: 'laya', input: 'a', questions }
    })
    assert.equal(response.statusCode, 500)
    assert.equal(response.json().error.code, 'internal_error')
  })
})
