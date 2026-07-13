import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authHeaders,
  redactUrl,
  redactedErrorMessage,
  redirectRequest,
  selectWarmEntries
} from './warm-models.mjs'

const HF_URL = 'https://huggingface.co/example/model/resolve/main/model.gguf'

test('authHeaders sends HF_TOKEN only to exact HTTPS huggingface.co', () => {
  assert.equal(authHeaders(HF_URL, 'secret').authorization, 'Bearer secret')
  assert.equal(
    authHeaders('https://huggingface.co.attacker.example/model.gguf', 'secret').authorization,
    undefined
  )
  assert.equal(
    authHeaders('https://not-huggingface.co/model.gguf', 'secret').authorization,
    undefined
  )
  assert.equal(
    authHeaders('https://huggingface.co@attacker.example/model.gguf', 'secret').authorization,
    undefined
  )
  assert.equal(authHeaders('http://huggingface.co/model.gguf', 'secret').authorization, undefined)
})

test('redirectRequest recomputes credentials for each target host', () => {
  const crossHost = redirectRequest(
    'https://cdn.example/model.gguf?X-Amz-Credential=signed-secret',
    HF_URL,
    'secret'
  )
  assert.equal(crossHost.headers.authorization, undefined)

  const sameHost = redirectRequest('/example/model/download/model.gguf', HF_URL, 'secret')
  assert.equal(sameHost.headers.authorization, 'Bearer secret')
})

test('signed URL errors redact credentials, query strings, and fragments', () => {
  const signedUrl =
    'https://username:password@cdn.example/model.gguf?' +
    'X-Amz-Credential=query-secret#fragment-secret'

  assert.equal(redactUrl(signedUrl), 'https://cdn.example/model.gguf')
  const message = redactedErrorMessage(new Error(`HTTP 403 for ${signedUrl}`))
  assert.equal(message, 'HTTP 403 for https://cdn.example/model.gguf')
  assert.doesNotMatch(message, /username|password|query-secret|fragment-secret/)
})

test('selectWarmEntries excludes only entries explicitly deferred', () => {
  const manifest = {
    models: {
      default: { urls: ['https://example.com/default'] },
      explicit: { urls: ['https://example.com/explicit'], warm: true },
      deferred: { urls: ['https://example.com/deferred'], warm: false }
    }
  }

  assert.deepEqual(
    selectWarmEntries(manifest).map(([name]) => name),
    ['default', 'explicit']
  )
})

test('selectWarmEntries handles a missing models map', () => {
  assert.deepEqual(selectWarmEntries({}), [])
})
