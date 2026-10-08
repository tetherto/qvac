import { describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { LayaResult } from '@qvac/sdk'
import { buildServer } from '@/serve/index'
import type { DecideFn } from '@/serve/extensions/systemone/state'
import { writeConfigDir } from '../helpers/config.js'

const questions = {
  route: {
    type: 'choice' as const,
    instructions: 'Which queue?',
    criteria: { billing: 'Payments', technical: 'Bugs' }
  },
  severity: {
    type: 'score' as const,
    instructions: 'How severe?',
    criteria: ['Minor', 'Major']
  },
  urgent: { type: 'noul' as const, instructions: 'Does this need a human now?' }
}

const result: LayaResult = {
  model: 'native-checkpoint-name',
  answers: {
    route: {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.9, technical: 0.1 },
      answer_confidence: 0.9,
      confidence: 0.9,
      action: { act_probability: 0.9 }
    },
    severity: {
      type: 'score',
      score: 0.8,
      legend: { '0': 'Minor', '1': 'Major' },
      probabilities: { '0': 0.2, '1': 0.8 },
      answer_confidence: 0.8,
      confidence: 0.8,
      action: { act_probability: 0.8 }
    },
    urgent: {
      type: 'noul',
      noul: 0.7,
      answer_confidence: 0.7,
      confidence: 0.7,
      action: { act_probability: 0.7 }
    }
  },
  usage: {
    input_tokens: 42,
    output_tokens: 0,
    state_tokens: 12,
    state_tokens_dropped: 0,
    truncated: false,
    truncated_questions: []
  }
}

async function server(
  t: TestContext,
  options: { decideOverride?: DecideFn; apiKey?: string; lazy?: boolean } = {}
) {
  const projectRoot = await writeConfigDir(t, {
    serve: {
      load: { lazy: options.lazy ?? true },
      models: {
        laya: {
          src: '/models/laya.gguf',
          type: 'llamacpp-decisions',
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
    extensions: ['systemone'],
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    extensionOptions: { systemone: options },
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

describe('System One HTTP API', () => {
  it('lazy-loads once, forwards typed questions, and binds cancellation before awaiting', async (t) => {
    const calls: Parameters<DecideFn>[0][] = []
    const bound: string[] = []
    let completeDecision: (value: LayaResult) => void = () => {}
    let notifyBinding: (id: string) => void = () => {}
    const { app, loaded } = await server(t, {
      decideOverride: (params) => {
        calls.push(params)
        return Object.assign(
          new Promise<LayaResult>((resolve) => {
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
          url: '/v1/systemone',
          payload: { model, state, questions, max_len: 512, head_max_len: 128 }
        })
        .then((response) => response)
      assert.equal(await binding, 'decision-id')
      completeDecision(result)
      const response = await pending
      assert.equal(response.statusCode, 200, response.body)
      assert.deepEqual(response.json(), { ...result, model: 'laya' })
      assert.match(response.headers['content-type'] ?? '', /application\/json/)
      assert.deepEqual(calls.at(-1), {
        modelId: 'sdk-laya-id',
        state,
        questions,
        max_len: 512,
        head_max_len: 128
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
      url: '/v1/systemone',
      payload: { model: 'laya', state: 'a', questions }
    })
    assert.equal(response.statusCode, 503)
    assert.equal(response.json().error.code, 'model_load_failed')
  })

  it('rejects malformed requests, batching, and streaming before loading a model', async (t) => {
    const { app, loaded } = await server(t)
    const valid = { model: 'laya', state: 'Charged twice', questions }
    for (const payload of [
      { state: valid.state, questions },
      { ...valid, state: null },
      { model: 'laya', states: ['a', 'b'], questions },
      { ...valid, stream: true },
      { ...valid, questions: { bad: { type: 'boolean', instructions: 'Urgent?' } } },
      { ...valid, max_len: 0 }
    ]) {
      const response = await app.inject({ method: 'POST', url: '/v1/systemone', payload })
      assert.equal(response.statusCode, 400, response.body)
    }
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
        url: '/v1/systemone',
        payload: { model, state: 'a', questions }
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
      url: '/v1/systemone',
      payload: { model: 'laya', state: 'a', questions }
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
      url: '/v1/systemone',
      payload: { model: 'laya', state: 'a', questions }
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
    assert.ok(paths['/v1/systemone'].post)
    assert.equal(paths['/v1/chat/completions'], undefined)
    assert.match(JSON.stringify(paths['/v1/systemone']), /questions/)
    assert.match(JSON.stringify(paths['/v1/systemone']), /answers/)
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
      url: '/v1/systemone',
      payload: { model: 'laya', state: 'a', questions }
    })
    assert.equal(response.statusCode, 500)
    assert.equal(response.json().error.code, 'internal_error')
  })
})
