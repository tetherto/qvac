import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { CompletionRun, CompletionStats, ToolCall } from '@qvac/sdk'
import { createServer } from '../helpers/server.js'
import { JSON_HEADERS, assertStatusAndError, collectSSE } from '../helpers/http.js'
import { openaiState } from '@/serve/extensions/openai/state'
import { responsesKvCacheRetention } from '@/serve/lib/responses-kv-cache'

function server(t: Parameters<typeof createServer>[0]) {
  return createServer(t, {
    cors: true,
    corsOrigins: ['http://localhost:3000'],
    config: {
      serve: {
        models: {
          'test-llm': {
            model: 'QWEN3_600M_INST_Q4',
            preload: false,
            config: { ctx_size: 2048, tools: true }
          }
        }
      }
    },
    loadModelOverride: () => Promise.resolve('mock-model-id')
  })
}

function cacheKey(key: string) {
  return `responses-${createHash('sha256').update(key).digest('hex')}`
}

function stubRun(stats?: CompletionStats, toolCalls: ToolCall[] = []): CompletionRun {
  async function* events(): AsyncGenerator<unknown> {
    let seq = 0
    yield { type: 'contentDelta', seq: seq++, text: 'hello' }
    for (const call of toolCalls) yield { type: 'toolCall', seq: seq++, call }
    if (stats) yield { type: 'completionStats', seq: seq++, stats }
    yield { type: 'completionDone', seq: seq++, stopReason: 'eos' }
  }
  return {
    requestId: 'responses-kv-cache-request',
    events: events(),
    final: Promise.resolve(undefined)
  } as unknown as CompletionRun
}

interface SeenRequest {
  kvCache?: string | boolean | undefined
  stream?: boolean | undefined
  history: Array<{
    role: string
    content?: string | null | undefined
    toolCallId?: string | undefined
  }>
}

describe('serve: Responses KV cache', () => {
  it('allows the extension header through CORS preflight', { timeout: 15000 }, async (t) => {
    const app = await server(t)
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/responses',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-qvac-kv-cache-key'
      }
    })
    assert.equal(res.statusCode, 204, res.payload)
    assert.match(
      String(res.headers['access-control-allow-headers']).toLowerCase(),
      /x-qvac-kv-cache-key/
    )
  })
  for (const stream of [false, true]) {
    for (const source of ['header', 'metadata', 'prompt_cache_key']) {
      it(`${source} reaches the SDK (stream=${stream})`, { timeout: 15000 }, async (t) => {
        const app = await server(t)
        await app.ready()
        const seen: SeenRequest[] = []
        openaiState(app.qvac).completionOverride = (params) => {
          seen.push(params)
          return stubRun({ cacheTokens: 128, promptTokens: 144, emittedTokens: 2 })
        }
        const res = await app.inject({
          method: 'POST',
          url: '/v1/responses',
          headers: {
            ...JSON_HEADERS,
            ...(source === 'header' ? { 'X-QVAC-KV-Cache-Key': 'session-a' } : {})
          },
          payload: {
            model: 'test-llm',
            input: 'hello',
            stream,
            ...(source === 'metadata' ? { metadata: { qvac_kv_cache_key: 'session-a' } } : {}),
            ...(source === 'prompt_cache_key' ? { prompt_cache_key: 'session-a' } : {})
          }
        })
        assert.equal(res.statusCode, 200, res.payload)
        assert.equal(seen[0]?.kvCache, cacheKey('session-a'))
        assert.equal(seen[0]?.stream, stream)
        const body = stream
          ? (
              collectSSE(res.payload).find(
                (e) => (e.data as { type?: string }).type === 'response.completed'
              )?.data as { response: Record<string, unknown> }
            ).response
          : res.json()
        assert.deepEqual(body.usage, {
          input_tokens: 0,
          qvac_cache_tokens: 128,
          output_tokens: 2,
          total_tokens: 2
        })
      })
    }

    it(`omits kvCache without the extension (stream=${stream})`, { timeout: 15000 }, async (t) => {
      const app = await server(t)
      await app.ready()
      openaiState(app.qvac).completionOverride = (params) => {
        assert.equal('kvCache' in params, false)
        return stubRun({ cacheTokens: 128, emittedTokens: 1 })
      }
      const res = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: JSON_HEADERS,
        payload: { model: 'test-llm', input: 'hello', stream }
      })
      assert.equal(res.statusCode, 200, res.payload)
      // Occupancy is reported only for a named session.
      const body = stream
        ? (
            collectSSE(res.payload).find(
              (e) => (e.data as { type?: string }).type === 'response.completed'
            )?.data as { response: Record<string, unknown> }
          ).response
        : res.json()
      assert.deepEqual(body.usage, { input_tokens: 0, output_tokens: 1, total_tokens: 1 })
    })

    it(
      `retains the session across stored tool-call turns (stream=${stream})`,
      { timeout: 15000 },
      async (t) => {
        const app = await server(t)
        await app.ready()
        const seen: SeenRequest[] = []
        openaiState(app.qvac).completionOverride = (params) => {
          seen.push(params)
          return seen.length === 1
            ? stubRun({ cacheTokens: 0 }, [{ id: 'call_1', name: 'weather', arguments: {} }])
            : stubRun({ cacheTokens: 128 })
        }
        const headers = { ...JSON_HEADERS, 'X-QVAC-KV-Cache-Key': 'tool-session' }
        const first = await app.inject({
          method: 'POST',
          url: '/v1/responses',
          headers,
          payload: {
            model: 'test-llm',
            input: 'weather?',
            tools: [
              { type: 'function', name: 'weather', parameters: { type: 'object', properties: {} } }
            ]
          }
        })
        assert.equal(first.statusCode, 200, first.payload)
        assert.equal(first.json().usage.qvac_cache_tokens, 0)
        const second = await app.inject({
          method: 'POST',
          url: '/v1/responses',
          headers,
          payload: {
            model: 'test-llm',
            stream,
            previous_response_id: first.json().id,
            input: [{ type: 'function_call_output', call_id: 'call_1', output: 'sunny' }]
          }
        })
        assert.equal(second.statusCode, 200, second.payload)
        assert.equal(seen.length, 2)
        assert.deepEqual(
          seen.map((p) => p.kvCache),
          [cacheKey('tool-session'), cacheKey('tool-session')]
        )
        assert.ok(seen[1]!.history.length > seen[0]!.history.length)
        assert.equal(seen[1]!.history.at(-1)?.toolCallId, 'call_1')
      }
    )
  }

  it('gives the header precedence over the metadata fallback', { timeout: 15000 }, async (t) => {
    const app = await server(t)
    await app.ready()
    openaiState(app.qvac).completionOverride = (params) => {
      assert.equal(params.kvCache, cacheKey('header-session'))
      return stubRun()
    }
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { ...JSON_HEADERS, 'X-QVAC-KV-Cache-Key': 'header-session' },
      payload: {
        model: 'test-llm',
        input: 'hello',
        metadata: { qvac_kv_cache_key: 'metadata-session' }
      }
    })
    assert.equal(res.statusCode, 200, res.payload)
  })

  it(
    'skips inference when the client leaves while its key waits',
    { timeout: 15000 },
    async (t) => {
      const app = await server(t)
      await app.ready()
      let called = false
      openaiState(app.qvac).completionOverride = () => {
        called = true
        return stubRun()
      }
      let finishDeletion!: () => void
      const deletion = new Promise<void>((resolve) => {
        finishDeletion = resolve
      })
      let waiting!: () => void
      const waitStarted = new Promise<void>((resolve) => {
        waiting = resolve
      })
      t.mock.method(responsesKvCacheRetention, 'acquire', async () => {
        waiting()
        await deletion
        return () => {}
      })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const controller = new AbortController()
      const pending = fetch(`${address}/v1/responses`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test-llm', input: 'hello', prompt_cache_key: 'session-a' })
      })
      pending.catch(() => {})
      await waitStarted
      controller.abort()
      await new Promise((resolve) => setTimeout(resolve, 50))
      finishDeletion()
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(called, false)
    }
  )

  it('prefers metadata over prompt_cache_key', { timeout: 15000 }, async (t) => {
    const app = await server(t)
    await app.ready()
    openaiState(app.qvac).completionOverride = (params) => {
      assert.equal(params.kvCache, cacheKey('metadata-session'))
      return stubRun()
    }
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: JSON_HEADERS,
      payload: {
        model: 'test-llm',
        input: 'hello',
        metadata: { qvac_kv_cache_key: 'metadata-session' },
        prompt_cache_key: 'prompt-session'
      }
    })
    assert.equal(res.statusCode, 200, res.payload)
  })

  it('rejects a repeated header instead of joining its values', { timeout: 15000 }, async (t) => {
    const app = await server(t)
    await app.ready()
    let called = false
    openaiState(app.qvac).completionOverride = () => {
      called = true
      return stubRun()
    }
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { ...JSON_HEADERS, 'X-QVAC-KV-Cache-Key': ['session-a', 'session-b'] },
      payload: { model: 'test-llm', input: 'hello' }
    })
    assertStatusAndError(res, 400, 'invalid_kv_cache_key')
    assert.equal(called, false)
  })

  for (const key of [
    '',
    '   ',
    'x'.repeat(513),
    'é'.repeat(257),
    `${' '.repeat(512)}x`,
    42,
    null,
    {},
    ['key']
  ]) {
    it(
      `rejects invalid metadata key ${JSON.stringify(key).slice(0, 35)}`,
      { timeout: 15000 },
      async (t) => {
        const app = await server(t)
        await app.ready()
        let called = false
        openaiState(app.qvac).completionOverride = () => {
          called = true
          return stubRun()
        }
        const res = await app.inject({
          method: 'POST',
          url: '/v1/responses',
          headers: JSON_HEADERS,
          payload: {
            model: 'test-llm',
            input: 'hello',
            stream: true,
            metadata: { qvac_kv_cache_key: key }
          }
        })
        assertStatusAndError(res, 400, 'invalid_kv_cache_key')
        assert.equal(called, false)
      }
    )
  }

  for (const key of ['', 'x'.repeat(513)]) {
    it(`rejects invalid header key of length ${key.length}`, { timeout: 15000 }, async (t) => {
      const app = await server(t)
      const res = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: { ...JSON_HEADERS, 'X-QVAC-KV-Cache-Key': key },
        payload: {
          model: 'test-llm',
          input: 'hello',
          metadata: { qvac_kv_cache_key: 'valid-fallback' }
        }
      })
      assertStatusAndError(res, 400, 'invalid_kv_cache_key')
    })
  }

  for (const key of [
    '../outside/cache',
    '/tmp/absolute',
    'true',
    'é'.repeat(256),
    'x'.repeat(512)
  ]) {
    it(`hashes opaque key ${key.slice(0, 25)}`, { timeout: 15000 }, async (t) => {
      const app = await server(t)
      await app.ready()
      openaiState(app.qvac).completionOverride = (params) => {
        assert.equal(params.kvCache, cacheKey(key))
        assert.match(String(params.kvCache), /^responses-[a-f0-9]{64}$/)
        return stubRun()
      }
      const res = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: JSON_HEADERS,
        payload: { model: 'test-llm', input: 'hello', metadata: { qvac_kv_cache_key: key } }
      })
      assert.equal(res.statusCode, 200, res.payload)
    })
  }
})
