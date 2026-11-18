import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { InvalidKvCacheKeyError, namedKvCacheKey } from '@/serve/lib/named-kv-cache'
import { chatCompletionsBody, toSdkChatArgs } from '@/serve/extensions/openai/schemas/chat'
import { toSdkResponsesArgs } from '@/serve/extensions/openai/schemas/responses'
import { buildUsage } from '@/serve/extensions/openai/adapters/chat-shapes'

function cacheKey(key: string) {
  return `responses-${createHash('sha256').update(key).digest('hex')}`
}

const HEADER = ['X-QVAC-KV-Cache-Key', 'header-session']

describe('namedKvCacheKey', () => {
  it('returns undefined when the request names no key', () => {
    assert.equal(namedKvCacheKey([], {}), undefined)
    assert.equal(namedKvCacheKey(['Content-Type', 'application/json'], { metadata: {} }), undefined)
    assert.equal(namedKvCacheKey([], { metadata: null }), undefined)
  })

  it('prefers the header, then metadata, then prompt_cache_key', () => {
    const body = { metadata: { qvac_kv_cache_key: 'metadata-session' }, prompt_cache_key: 'prompt' }
    assert.equal(namedKvCacheKey(HEADER, body), cacheKey('header-session'))
    assert.equal(namedKvCacheKey([], body), cacheKey('metadata-session'))
    assert.equal(namedKvCacheKey([], { prompt_cache_key: 'prompt' }), cacheKey('prompt'))
  })

  it('matches the header name case-insensitively', () => {
    assert.equal(namedKvCacheKey(['x-qvac-kv-cache-key', 'a'], {}), cacheKey('a'))
  })

  it('rejects a repeated header', () => {
    assert.throws(
      () => namedKvCacheKey([...HEADER, 'x-qvac-kv-cache-key', 'other'], {}),
      InvalidKvCacheKeyError
    )
  })

  it('rejects an invalid key instead of falling back to a later source', () => {
    for (const key of ['', '   ', 'x'.repeat(513), 'é'.repeat(257), 42, null, {}, ['key']]) {
      assert.throws(
        () => namedKvCacheKey([], { metadata: { qvac_kv_cache_key: key }, prompt_cache_key: 'ok' }),
        InvalidKvCacheKeyError,
        JSON.stringify(key).slice(0, 30)
      )
    }
    assert.throws(
      () => namedKvCacheKey(['X-QVAC-KV-Cache-Key', ''], { prompt_cache_key: 'ok' }),
      InvalidKvCacheKeyError
    )
    assert.throws(() => namedKvCacheKey([], { prompt_cache_key: 7 }), InvalidKvCacheKeyError)
  })

  it('hashes path-like keys so they never reach the cache layout', () => {
    for (const key of ['../outside/cache', '/tmp/absolute', 'x'.repeat(512)]) {
      assert.match(namedKvCacheKey([], { prompt_cache_key: key })!, /^responses-[a-f0-9]{64}$/)
    }
  })
})

describe('toSdkChatArgs: KV cache key', () => {
  const messages = [{ role: 'user', content: 'hello' }]

  function args(extra: Record<string, unknown>, rawHeaders: string[] = []) {
    return toSdkChatArgs(chatCompletionsBody.parse({ model: 'm', messages, ...extra }), rawHeaders)
  }

  it('leaves kvCache undefined without a key, so the route auto-caches', () => {
    assert.equal(args({}).kvCache, undefined)
    assert.equal(args({ metadata: { team: 'a' } }).kvCache, undefined)
    assert.equal(args({ metadata: null }).kvCache, undefined)
  })

  it('reads the key from each source in order of precedence', () => {
    const body = { metadata: { qvac_kv_cache_key: 'metadata-session' }, prompt_cache_key: 'prompt' }
    assert.equal(args(body, HEADER).kvCache, cacheKey('header-session'))
    assert.equal(args(body).kvCache, cacheKey('metadata-session'))
    assert.equal(args({ prompt_cache_key: 'prompt' }).kvCache, cacheKey('prompt'))
  })

  it('rejects an invalid key', () => {
    assert.throws(() => args({ prompt_cache_key: '' }), InvalidKvCacheKeyError)
    assert.throws(() => args({ prompt_cache_key: 12 }), InvalidKvCacheKeyError)
    assert.throws(() => args({ metadata: { qvac_kv_cache_key: ' ' } }), InvalidKvCacheKeyError)
  })

  it('keeps the same key on the follow-up after a tool call', () => {
    const first = args({ prompt_cache_key: 'agent-session' })
    const call = {
      id: 'call_1',
      type: 'function',
      function: { name: 'read_file', arguments: '{}' }
    }
    const followUp = toSdkChatArgs(
      chatCompletionsBody.parse({
        model: 'm',
        prompt_cache_key: 'agent-session',
        messages: [
          ...messages,
          { role: 'assistant', content: '', tool_calls: [call] },
          { role: 'tool', tool_call_id: 'call_1', content: '# Demo' }
        ]
      })
    )
    assert.equal(followUp.kvCache, first.kvCache)
    assert.equal(followUp.history.at(-1)?.toolCallId, 'call_1')
  })

  it('selects the same session as a Responses request with that key', () => {
    const responses = toSdkResponsesArgs({ model: 'm', input: 'hello', prompt_cache_key: 'shared' })
    assert.equal(args({ prompt_cache_key: 'shared' }).kvCache, responses.kvCache)
  })
})

describe('buildUsage: qvac_cache_tokens', () => {
  it('reports cache occupancy only when given', () => {
    assert.deepEqual(buildUsage({ completionTokens: 2, promptTokens: 10, cacheTokens: 128 }), {
      prompt_tokens: 10,
      qvac_cache_tokens: 128,
      completion_tokens: 2,
      total_tokens: 12
    })
    assert.deepEqual(buildUsage({ completionTokens: 2, promptTokens: 10 }), {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12
    })
  })
})
