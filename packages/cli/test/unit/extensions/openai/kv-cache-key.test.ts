import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { InvalidKvCacheKeyError, namedKvCacheKey } from '@/serve/lib/named-kv-cache'
import { chatCompletionsBody, toSdkChatArgs } from '@/serve/extensions/openai/schemas/chat'
import { toSdkResponsesArgs } from '@/serve/extensions/openai/schemas/responses'
import { buildUsage } from '@/serve/extensions/openai/adapters/chat-shapes'

function cacheKey(key: string, scope?: unknown[]) {
  const hash = createHash('sha256').update(key)
  if (scope) hash.update('\0').update(JSON.stringify(scope))
  return `responses-${hash.digest('hex')}`
}

const HEADER = ['X-QVAC-KV-Cache-Key', 'header-session']

describe('namedKvCacheKey', () => {
  it('returns undefined when the request names no key', () => {
    assert.equal(namedKvCacheKey([], {}), undefined)
    assert.equal(namedKvCacheKey(['Content-Type', 'application/json'], { metadata: {} }), undefined)
    assert.equal(namedKvCacheKey([], { metadata: null }), undefined)
    assert.equal(namedKvCacheKey([], { prompt_cache_key: null }), undefined)
  })

  it('applies the scope to prompt_cache_key only', () => {
    const body = { metadata: { qvac_kv_cache_key: 'metadata-session' } }
    assert.equal(namedKvCacheKey(HEADER, {}, 'scope'), cacheKey('header-session'))
    assert.equal(namedKvCacheKey([], body, 'scope'), cacheKey('metadata-session'))
    assert.notEqual(
      namedKvCacheKey([], { prompt_cache_key: 'user' }, 'a'),
      namedKvCacheKey([], { prompt_cache_key: 'user' }, 'b')
    )
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
    assert.equal(args({ prompt_cache_key: null }).kvCache, undefined)
  })

  it('reads the key from each source in order of precedence', () => {
    const body = { metadata: { qvac_kv_cache_key: 'metadata-session' }, prompt_cache_key: 'prompt' }
    assert.equal(args(body, HEADER).kvCache, cacheKey('header-session'))
    assert.equal(args(body).kvCache, cacheKey('metadata-session'))
    assert.equal(args({ prompt_cache_key: 'prompt' }).kvCache, cacheKey('prompt', messages))
  })

  it('gives each conversation its own session under one prompt_cache_key', () => {
    const system = { role: 'system', content: 'be brief' }
    const a = [system, { role: 'user', content: 'name a fruit' }]
    const b = [system, { role: 'user', content: 'name a colour' }]
    const key = { prompt_cache_key: 'user-1' }
    assert.equal(args({ ...key, messages: a }).kvCache, cacheKey('user-1', a))
    assert.notEqual(args({ ...key, messages: a }).kvCache, args({ ...key, messages: b }).kvCache)
    const later = [...a, { role: 'assistant', content: 'apple' }, { role: 'user', content: 'more' }]
    assert.equal(args({ ...key, messages: later }).kvCache, args({ ...key, messages: a }).kvCache)
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

  it('selects the same session as a Responses request with that header or metadata key', () => {
    const metadata = { qvac_kv_cache_key: 'shared' }
    const responses = toSdkResponsesArgs({ model: 'm', input: 'hello', metadata })
    assert.equal(args({ metadata }).kvCache, responses.kvCache)
    assert.equal(
      args({}, HEADER).kvCache,
      toSdkResponsesArgs({ model: 'm', input: 'hi' }, HEADER).kvCache
    )
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

  it('reports the reused part of the prompt as cached_tokens', () => {
    assert.deepEqual(buildUsage({ completionTokens: 2, promptTokens: 300, cachedTokens: 290 }), {
      prompt_tokens: 300,
      prompt_tokens_details: { cached_tokens: 290 },
      completion_tokens: 2,
      total_tokens: 302
    })
  })
})
