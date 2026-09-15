import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from '../helpers/server.js'
import { assertStatusAndError, JSON_HEADERS } from '../helpers/http.js'
import { WorkerStartupError } from '@qvac/sdk'

function rpcTimeout(cause?: unknown): Error {
  return new Error(
    'RPC initialization timed out after 30000ms — the worker process may have failed to start',
    { cause }
  )
}

const CHAT_BODY = { model: '', messages: [{ role: 'user', content: 'hi' }] }

function chat(model: string) {
  return JSON.stringify({ ...CHAT_BODY, model })
}

describe('serve: load config', () => {
  for (const route of [
    {
      url: '/v1/chat/completions',
      type: 'llamacpp-completion',
      body: { messages: [{ role: 'user', content: 'hi' }] }
    },
    { url: '/v1/responses', type: 'llamacpp-completion', body: { input: 'hi' } },
    { url: '/qvac/v1/translate', type: 'nmtcpp-translation', body: { text: 'hola' } }
  ]) {
    it(`${route.url}: a worker exit returns a safe startup hint in the 503 body`, async (t) => {
      const stderr =
        '/private/addon.bare: libatomic.so.1: cannot open shared object file: No such file or directory\nprivate diagnostic marker'
      const cause = new WorkerStartupError(
        'worker exited',
        { code: null, signal: 'SIGABRT' },
        stderr
      )
      const error = rpcTimeout(cause)
      const app = await createServer(t, {
        config: {
          serve: {
            models: {
              failed: { type: route.type, src: 'hyper://example.invalid/model', preload: false }
            }
          }
        },
        loadModelOverride: () => Promise.reject(error)
      })

      const res = await app.inject({
        method: 'POST',
        url: route.url,
        payload: { model: 'failed', ...route.body }
      })

      assertStatusAndError(res, 503, 'model_load_failed')
      assert.match(res.body, /Worker process exited.*before IPC connection was established/)
      assert.match(res.body, /install libatomic1 in the environment running the worker/)
      assert.doesNotMatch(res.body, /timed out|30000|\/private\/|diagnostic marker/)
      assert.equal(error.cause, cause)
      assert.equal(cause.stderrTail, stderr)
    })
  }

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
