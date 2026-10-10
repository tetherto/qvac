import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from '../helpers/server.js'
import { assertStatusAndError, JSON_HEADERS } from '../helpers/http.js'
import { WorkerStartupError } from '@qvac/sdk'

import { rpcTimeout } from '../../helpers/worker-startup.js'

const CHAT_BODY = { model: '', messages: [{ role: 'user', content: 'hi' }] }

function chat(model: string) {
  return JSON.stringify({ ...CHAT_BODY, model })
}

describe('serve: load config', () => {
  it('a worker exit returns a safe startup summary in the HTTP 503 body', async (t) => {
    const cause = new WorkerStartupError(
      '/private/worker',
      { code: null, signal: 'SIGABRT' },
      'private diagnostic marker'
    )
    const app = await createServer(t, {
      config: {
        serve: {
          models: {
            failed: {
              type: 'llamacpp-completion',
              src: 'hyper://example.invalid/model',
              preload: false
            }
          }
        }
      },
      loadModelOverride: () => Promise.reject(rpcTimeout(cause))
    })
    const errors: string[] = []
    app.qvac.logger.error = (message) => errors.push(message)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: JSON_HEADERS,
      payload: chat('failed')
    })

    assertStatusAndError(res, 503, 'model_load_failed')
    assert.equal(
      res.json().error.message,
      'Model "failed" failed to load: Worker process exited (signal SIGABRT) before IPC was established'
    )
    assert.doesNotMatch(res.body, /timed out|30000|private|diagnostic marker/)
    assert.equal(errors.length, 1)
    assert.match(errors[0]!, /RPC initialization timed out/)
    assert.ok(errors[0]!.includes(cause.message))
  })

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
