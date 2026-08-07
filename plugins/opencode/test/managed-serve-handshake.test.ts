import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createManagedProviderConfig, parseHostListening } from '../src/managed-serve-handshake.ts'

const apiKey = 'a'.repeat(43)

test('managed host handshake accepts and injects the exact managed key', () => {
  const listening = parseHostListening(
    JSON.stringify({
      apiKey,
      baseURL: 'http://127.0.0.1:12345/v1',
      modelId: 'qwen3.5-9b',
      modelName: 'Qwen 3.5 9B'
    })
  )

  const provider = createManagedProviderConfig(listening, 123_000)

  assert.equal(provider.options?.apiKey, apiKey)
  assert.notEqual(provider.options?.apiKey, 'qvac')
})

test('managed host handshake rejects a missing key', () => {
  assert.throws(
    () =>
      parseHostListening(
        JSON.stringify({
          baseURL: 'http://127.0.0.1:12345/v1',
          modelId: 'qwen3.5-9b',
          modelName: 'Qwen 3.5 9B'
        })
      ),
    /apiKey/
  )
})

test('managed host handshake rejects an invalid key', () => {
  assert.throws(
    () =>
      parseHostListening(
        JSON.stringify({
          apiKey: 'qvac',
          baseURL: 'http://127.0.0.1:12345/v1',
          modelId: 'qwen3.5-9b',
          modelName: 'Qwen 3.5 9B'
        })
      ),
    /apiKey/
  )
})
