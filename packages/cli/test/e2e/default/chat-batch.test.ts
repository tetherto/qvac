import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useServer } from '../helpers/server.js'
import { JSON_HEADERS, assertStatusAndError } from '../helpers/http.js'

const URL = '/qvac/v1/chat/batch'

const BATCH_CONFIG = {
  serve: {
    models: {
      'chat-model': {
        type: 'llamacpp-completion',
        src: 'hyper://example.invalid/chat',
        preload: false
      },
      'ta-en': {
        type: 'nmtcpp-translation',
        src: 'hyper://example.invalid/ta-en',
        preload: false
      }
    }
  }
} as const

const prompt = { messages: [{ role: 'user', content: 'hi' }] }

describe('qvac chat batch: validation', () => {
  const server = useServer({ config: BATCH_CONFIG })

  function post(payload: unknown) {
    return server().inject({ method: 'POST', url: URL, payload: payload as object })
  }

  it('invalid JSON returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: URL,
      headers: JSON_HEADERS,
      payload: '{{bad'
    })
    assertStatusAndError(res, 400, 'invalid_json')
  })

  it('missing model returns 400', async () => {
    assertStatusAndError(await post({ prompts: [prompt] }), 400, 'missing_model')
  })

  it('missing or empty prompts returns invalid_prompts', async () => {
    assertStatusAndError(await post({ model: 'chat-model' }), 400, 'invalid_prompts')
    assertStatusAndError(await post({ model: 'chat-model', prompts: [] }), 400, 'invalid_prompts')
  })

  it('a prompt without messages returns invalid_prompts', async () => {
    const res = await post({ model: 'chat-model', prompts: [prompt, { id: 'x' }] })
    assertStatusAndError(res, 400, 'invalid_prompts')
  })

  it('an unknown field on a prompt returns invalid_prompts', async () => {
    const res = await post({ model: 'chat-model', prompts: [{ ...prompt, n: 2 }] })
    assertStatusAndError(res, 400, 'invalid_prompts')
  })

  it('rejects a batch over the prompt cap with its own code', async () => {
    const res = await post({
      model: 'chat-model',
      prompts: Array.from({ length: 65 }, () => prompt)
    })
    assertStatusAndError(res, 400, 'too_many_prompts')
  })

  it('rejects an unknown top-level field', async () => {
    const res = await post({ model: 'chat-model', prompts: [prompt], stream: true })
    assertStatusAndError(res, 400, 'invalid_request')
  })

  it('rejects duplicate prompt ids before loading the model', async () => {
    const res = await post({
      model: 'chat-model',
      prompts: [
        { ...prompt, id: 'a' },
        { ...prompt, id: 'a' }
      ]
    })
    assertStatusAndError(res, 400, 'duplicate_prompt_id')
    const entry = server().qvac.registry.getEntry('chat-model')
    assert.notEqual(entry?.state, server().qvac.registry.STATES.READY)
  })

  it('rejects an alias without parallel slots before loading the model', async () => {
    const res = await post({ model: 'chat-model', prompts: [prompt] })
    assertStatusAndError(res, 400, 'batch_not_enabled')
    const entry = server().qvac.registry.getEntry('chat-model')
    assert.notEqual(entry?.state, server().qvac.registry.STATES.READY)
  })

  it('unknown model returns 404', async () => {
    assertStatusAndError(await post({ model: 'nope', prompts: [prompt] }), 404, 'model_not_found')
  })

  it('a translation model returns invalid_model_type', async () => {
    const res = await post({ model: 'ta-en', prompts: [prompt] })
    assertStatusAndError(res, 400, 'invalid_model_type')
  })
})

describe('qvac chat batch: surface', () => {
  const server = useServer({ config: BATCH_CONFIG })

  it('is published in openapi.json, listing each error code under its status', async () => {
    const res = await server().inject({ method: 'GET', url: '/openapi.json' })
    assert.equal(res.statusCode, 200)
    const doc = res.json() as {
      paths: Record<
        string,
        Record<string, { tags?: string[]; responses?: Record<string, { description?: string }> }>
      >
    }
    const operation = doc.paths[URL]?.['post']
    assert.notEqual(operation, undefined, 'chat/batch has no POST in openapi.json')
    assert.deepEqual(operation?.tags, ['Chat Batch'])
    const listed = (status: string) => operation?.responses?.[status]?.description ?? ''
    for (const code of ['too_many_prompts', 'duplicate_prompt_id', 'batch_not_enabled']) {
      assert.match(listed('400'), new RegExp(`\`${code}\``))
    }
    assert.match(listed('404'), /`model_not_found`/)
    assert.match(listed('429'), /`request_rejected_by_policy`/)
    assert.match(listed('502'), /`inference_failed`/)
    assert.match(listed('503'), /`model_not_loaded`/)
  })
})

describe('qvac chat batch: QVAC surface alone', () => {
  const server = useServer({ config: BATCH_CONFIG, extensions: ['default'] })

  it('validates without the openai extension mounted', async () => {
    const res = await server().inject({
      method: 'POST',
      url: URL,
      payload: { model: 'ta-en', prompts: [prompt] }
    })
    assertStatusAndError(res, 400, 'invalid_model_type')
  })
})

describe('qvac chat batch: not mounted without the QVAC surface', () => {
  const server = useServer({ config: BATCH_CONFIG, extensions: ['openai'] })

  it('returns 404', async () => {
    const res = await server().inject({
      method: 'POST',
      url: URL,
      payload: { model: 'chat-model', prompts: [prompt] }
    })
    assert.equal(res.statusCode, 404)
  })
})
