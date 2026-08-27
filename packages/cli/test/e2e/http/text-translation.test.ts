import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TestContext } from 'node:test'
import type { translate } from '@qvac/sdk'
import { createServer, useServer } from '../helpers/server.js'
import { JSON_HEADERS, assertStatusAndError, collectSSE } from '../helpers/http.js'

type TranslateParams = Parameters<typeof translate>[0]
type TranslateResult = ReturnType<typeof translate>

const TEXT_CONFIG = {
  serve: {
    models: {
      'ta-en': { type: 'nmtcpp-translation', src: 'hyper://example.invalid/ta-en', preload: false },
      'chat-model': {
        type: 'llamacpp-completion',
        src: 'hyper://example.invalid/chat',
        preload: false
      }
    }
  }
} as const

function makeTranslateOverride(calls: TranslateParams[]) {
  function translateOverride(params: TranslateParams): TranslateResult {
    calls.push(params)
    const single = Array.isArray(params.text) ? params.text.join(' ') : params.text
    const out = `[${single}]`
    return {
      requestId: `req-${calls.length}`,
      text: Promise.resolve(out),
      stats: Promise.resolve(undefined),
      tokenStream: (async function* () {
        yield out
      })()
    }
  }
  return translateOverride
}

async function createReadyTextServer(t: TestContext) {
  const calls: TranslateParams[] = []
  const app = await createServer(t, { config: TEXT_CONFIG })
  app.qvac.translateOverride = makeTranslateOverride(calls)
  await app.ready()
  for (const [alias, entry] of app.qvac.serveConfig.models) {
    app.qvac.registry.register(alias, entry)
  }
  app.qvac.registry.setReady('ta-en', 'sdk-ta-en')
  return { app, calls }
}

describe('serve: text translation validation', () => {
  const server = useServer({ config: TEXT_CONFIG })

  it('invalid JSON returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/text/translations',
      headers: JSON_HEADERS,
      payload: '{{bad'
    })
    assertStatusAndError(res, 400, 'invalid_json')
  })

  it('missing model returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/text/translations',
      payload: { input: 'வணக்கம்' }
    })
    assertStatusAndError(res, 400, 'missing_model')
  })

  it('missing input returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/text/translations',
      payload: { model: 'ta-en' }
    })
    assertStatusAndError(res, 400, 'missing_input')
  })

  it('unknown model returns 404', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/text/translations',
      payload: { model: 'nope', input: 'வணக்கம்' }
    })
    assertStatusAndError(res, 404, 'model_not_found')
  })

  it('non-translation model returns invalid_model_type', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/text/translations',
      payload: { model: 'chat-model', input: 'வணக்கம்' }
    })
    assertStatusAndError(res, 400, 'invalid_model_type')
  })
})

describe('serve: text translation', () => {
  it('translates a single input', async (t) => {
    const { app, calls } = await createReadyTextServer(t)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/text/translations',
      payload: { model: 'ta-en', input: 'வணக்கம்' }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      object: 'list',
      data: [{ object: 'translation', index: 0, text: '[வணக்கம்]' }],
      model: 'ta-en'
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.stream, false)
  })

  it('translates a batch with one call per input', async (t) => {
    const { app, calls } = await createReadyTextServer(t)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/text/translations',
      payload: { model: 'ta-en', input: ['a', 'b'] }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      object: 'list',
      data: [
        { object: 'translation', index: 0, text: '[a]' },
        { object: 'translation', index: 1, text: '[b]' }
      ],
      model: 'ta-en'
    })
    assert.equal(calls.length, 2)
  })

  it('streams a single input as SSE ending with [DONE]', async (t) => {
    const { app } = await createReadyTextServer(t)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/text/translations',
      payload: { model: 'ta-en', input: 'வணக்கம்', stream: true }
    })
    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['content-type']), /text\/event-stream/)
    const events = collectSSE(res.body)
    const chunk = events[0]?.data as { object: string; delta: string }
    assert.equal(chunk.object, 'text_translation.chunk')
    assert.equal(chunk.delta, '[வணக்கம்]')
    assert.equal(events.at(-1)?.data, '[DONE]')
  })

  it('rejects streaming a batch before any translate call', async (t) => {
    const { app, calls } = await createReadyTextServer(t)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/text/translations',
      payload: { model: 'ta-en', input: ['a', 'b'], stream: true }
    })
    assertStatusAndError(res, 400, 'unsupported_streaming')
    assert.equal(calls.length, 0)
  })
})
