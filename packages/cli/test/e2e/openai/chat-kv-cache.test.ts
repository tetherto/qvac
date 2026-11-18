import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { completion, CompletionRun, CompletionStats, ToolCall } from '@qvac/sdk'
import { createServer } from '../helpers/server.js'
import { JSON_HEADERS, assertStatusAndError, collectSSE } from '../helpers/http.js'
import { openaiState } from '@/serve/extensions/openai/state'
import { namedKvCacheRetention } from '@/serve/lib/named-kv-cache'

interface Retention {
  acquired: string[]
  released: number
}

function server(t: Parameters<typeof createServer>[0], retention?: Retention) {
  // The real retention works in the user's cache folder: it would leave lease
  // files there and could delete their expired caches.
  t.mock.method(namedKvCacheRetention, 'acquire', (key: string) => {
    retention?.acquired.push(key)
    return Promise.resolve(() => {
      if (retention) retention.released++
    })
  })
  t.mock.method(namedKvCacheRetention, 'maybeSweep', () => {})
  return createServer(t, {
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
    requestId: 'chat-kv-cache-request',
    events: events(),
    final: Promise.resolve(undefined)
  } as unknown as CompletionRun
}

type SeenRequest = Parameters<typeof completion>[0]

const MESSAGES = [{ role: 'user', content: 'hello' }]
const TOOLS = [
  {
    type: 'function',
    function: { name: 'weather', parameters: { type: 'object', properties: {} } }
  }
]

function usageOf(payload: string, stream: boolean): Record<string, number> {
  if (!stream) return (JSON.parse(payload) as { usage: Record<string, number> }).usage
  const chunk = collectSSE(payload).find(
    (e) => (e.data as { usage?: unknown } | undefined)?.usage !== undefined
  )
  return (chunk?.data as { usage: Record<string, number> }).usage
}

describe('serve: chat completions KV cache', () => {
  for (const stream of [false, true]) {
    for (const source of ['header', 'metadata', 'prompt_cache_key']) {
      it(`${source} names the SDK session (stream=${stream})`, { timeout: 15000 }, async (t) => {
        const retention: Retention = { acquired: [], released: 0 }
        const app = await server(t, retention)
        await app.ready()
        const seen: SeenRequest[] = []
        openaiState(app.qvac).completionOverride = (params) => {
          seen.push(params)
          return stubRun({ cacheTokens: 128, promptTokens: 144, emittedTokens: 2 })
        }
        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            ...JSON_HEADERS,
            ...(source === 'header' ? { 'X-QVAC-KV-Cache-Key': 'session-a' } : {})
          },
          payload: {
            model: 'test-llm',
            messages: MESSAGES,
            stream,
            ...(stream ? { stream_options: { include_usage: true } } : {}),
            ...(source === 'metadata' ? { metadata: { qvac_kv_cache_key: 'session-a' } } : {}),
            ...(source === 'prompt_cache_key' ? { prompt_cache_key: 'session-a' } : {})
          }
        })
        assert.equal(res.statusCode, 200, res.payload)
        assert.equal(seen[0]?.kvCache, cacheKey('session-a'))
        assert.deepEqual(retention, { acquired: [cacheKey('session-a')], released: 1 })
        assert.deepEqual(usageOf(res.payload, stream), {
          prompt_tokens: 144,
          qvac_cache_tokens: 128,
          completion_tokens: 2,
          total_tokens: 146
        })
      })
    }

    it(`auto-caches without a key (stream=${stream})`, { timeout: 15000 }, async (t) => {
      const retention: Retention = { acquired: [], released: 0 }
      const app = await server(t, retention)
      await app.ready()
      const seen: SeenRequest[] = []
      openaiState(app.qvac).completionOverride = (params) => {
        seen.push(params)
        return stubRun({ cacheTokens: 128, promptTokens: 144, emittedTokens: 2 })
      }
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: JSON_HEADERS,
        payload: {
          model: 'test-llm',
          messages: MESSAGES,
          stream,
          metadata: { team: 'a' },
          ...(stream ? { stream_options: { include_usage: true } } : {})
        }
      })
      assert.equal(res.statusCode, 200, res.payload)
      assert.equal(seen[0]?.kvCache, true)
      assert.deepEqual(retention, { acquired: [], released: 0 })
      // Occupancy is reported only for a named session.
      assert.deepEqual(usageOf(res.payload, stream), {
        prompt_tokens: 144,
        completion_tokens: 2,
        total_tokens: 146
      })
    })

    it(
      `keeps the session on the follow-up after a tool call (stream=${stream})`,
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
        const first = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: JSON_HEADERS,
          payload: {
            model: 'test-llm',
            messages: MESSAGES,
            tools: TOOLS,
            prompt_cache_key: 'tool-session'
          }
        })
        assert.equal(first.statusCode, 200, first.payload)
        const message = first.json().choices[0].message
        assert.equal(message.tool_calls[0].id, 'call_1')
        const second = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: JSON_HEADERS,
          payload: {
            model: 'test-llm',
            stream,
            tools: TOOLS,
            prompt_cache_key: 'tool-session',
            messages: [
              ...MESSAGES,
              { role: 'assistant', content: '', tool_calls: message.tool_calls },
              { role: 'tool', tool_call_id: 'call_1', content: 'sunny' }
            ]
          }
        })
        assert.equal(second.statusCode, 200, second.payload)
        assert.deepEqual(
          seen.map((p) => p.kvCache),
          [cacheKey('tool-session'), cacheKey('tool-session')]
        )
        assert.equal(seen[1]!.history.at(-1)?.toolCallId, 'call_1')
      }
    )
  }

  it('gives the header precedence over the body', { timeout: 15000 }, async (t) => {
    const app = await server(t)
    await app.ready()
    const seen: SeenRequest[] = []
    openaiState(app.qvac).completionOverride = (params) => {
      seen.push(params)
      return stubRun()
    }
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { ...JSON_HEADERS, 'X-QVAC-KV-Cache-Key': 'header-session' },
      payload: {
        model: 'test-llm',
        messages: MESSAGES,
        metadata: { qvac_kv_cache_key: 'metadata-session' },
        prompt_cache_key: 'prompt-session'
      }
    })
    assert.equal(res.statusCode, 200, res.payload)
    assert.equal(seen[0]?.kvCache, cacheKey('header-session'))
  })

  it('prefers metadata over prompt_cache_key', { timeout: 15000 }, async (t) => {
    const app = await server(t)
    await app.ready()
    const seen: SeenRequest[] = []
    openaiState(app.qvac).completionOverride = (params) => {
      seen.push(params)
      return stubRun()
    }
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: JSON_HEADERS,
      payload: {
        model: 'test-llm',
        messages: MESSAGES,
        metadata: { qvac_kv_cache_key: 'metadata-session' },
        prompt_cache_key: 'prompt-session'
      }
    })
    assert.equal(res.statusCode, 200, res.payload)
    assert.equal(seen[0]?.kvCache, cacheKey('metadata-session'))
  })

  it('releases the session when inference fails', { timeout: 15000 }, async (t) => {
    const retention: Retention = { acquired: [], released: 0 }
    const app = await server(t, retention)
    await app.ready()
    openaiState(app.qvac).completionOverride = () => {
      throw new Error('boom')
    }
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: JSON_HEADERS,
      payload: { model: 'test-llm', messages: MESSAGES, prompt_cache_key: 'session-a' }
    })
    assert.equal(res.statusCode >= 500, true, res.payload)
    assert.deepEqual(retention, { acquired: [cacheKey('session-a')], released: 1 })
  })

  const invalid: Array<[string, Record<string, string>, Record<string, unknown>]> = [
    ['empty prompt_cache_key', {}, { prompt_cache_key: '' }],
    ['non-string prompt_cache_key', {}, { prompt_cache_key: 42 }],
    ['oversized prompt_cache_key', {}, { prompt_cache_key: 'x'.repeat(513) }],
    ['blank metadata key', {}, { metadata: { qvac_kv_cache_key: '   ' } }],
    ['null metadata key', {}, { metadata: { qvac_kv_cache_key: null }, prompt_cache_key: 'ok' }],
    ['empty header', { 'X-QVAC-KV-Cache-Key': '' }, { prompt_cache_key: 'ok' }]
  ]
  for (const [name, headers, extra] of invalid) {
    it(`rejects ${name}`, { timeout: 15000 }, async (t) => {
      const app = await server(t)
      await app.ready()
      let called = false
      openaiState(app.qvac).completionOverride = () => {
        called = true
        return stubRun()
      }
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { ...JSON_HEADERS, ...headers },
        payload: { model: 'test-llm', messages: MESSAGES, ...extra }
      })
      assertStatusAndError(res, 400, 'invalid_kv_cache_key')
      assert.equal(called, false)
    })
  }
})
