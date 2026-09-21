import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from '../helpers/server.js'
import { assertStatusAndError, JSON_HEADERS } from '../helpers/http.js'

const CHAT_BODY = { model: '', messages: [{ role: 'user', content: 'hi' }] }

function chat(model: string) {
  return JSON.stringify({ ...CHAT_BODY, model })
}

describe('serve: load config', () => {
  it('lazy loading disabled → 503 model_not_loaded (no load attempted)', async (t) => {
    const app = await createServer(t, {
      config: {
        serve: {
          load: { lazy: false },
          models: { 'lazy-llm': { model: 'QWEN3_600M_INST_Q4', preload: false } }
        }
      }
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: JSON_HEADERS,
      payload: chat('lazy-llm')
    })
    assertStatusAndError(res, 503, 'model_not_loaded')
  })

  it('load timeout → 503 model_load_timeout', async (t) => {
    const app = await createServer(t, {
      config: {
        serve: {
          load: { timeoutMs: 30 },
          models: { 'slow-llm': { model: 'QWEN3_600M_INST_Q4', preload: false } }
        }
      },
      // Never resolves — the load-manager timeout must fire.
      loadModelOverride: () => new Promise<string>(() => {})
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: JSON_HEADERS,
      payload: chat('slow-llm')
    })
    assertStatusAndError(res, 503, 'model_load_timeout')
  })

  it('lists a configured model with its load state (idle before use)', async (t) => {
    const app = await createServer(t, {
      config: {
        serve: { models: { 'lazy-llm': { model: 'QWEN3_600M_INST_Q4', preload: false } } }
      }
    })
    const res = await app.inject({ method: 'GET', url: '/v1/models' })
    assert.equal(res.statusCode, 200)
    const body = res.json() as { data: Array<{ id: string; state: string }> }
    const entry = body.data.find((m) => m.id === 'lazy-llm')
    assert.equal(entry?.state, 'idle')
  })
})
