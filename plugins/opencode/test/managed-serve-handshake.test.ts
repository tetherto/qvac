import assert from 'node:assert/strict'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  createManagedProviderConfig,
  formatHostListening,
  generateProxyToken,
  parseHostListening,
  writeHostListening,
  HANDSHAKE_FD,
  HANDSHAKE_PREFIX
} from '../src/managed-serve-handshake.ts'

const proxyToken = 'a'.repeat(43)

function payload(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    proxyToken,
    baseURL: 'http://127.0.0.1:12345/v1',
    modelId: 'qwen3.5-9b',
    modelName: 'Qwen 3.5 9B',
    ...extra
  })
}

test('handshake carries the proxy token into OpenCode provider options', () => {
  const listening = parseHostListening(payload())

  const provider = createManagedProviderConfig(listening, 123_000)

  assert.equal(provider.options?.apiKey, proxyToken)
  assert.notEqual(provider.options?.apiKey, 'qvac')
})

test('handshake rejects a missing proxy token', () => {
  assert.throws(
    () =>
      parseHostListening(
        JSON.stringify({
          baseURL: 'http://127.0.0.1:12345/v1',
          modelId: 'qwen3.5-9b',
          modelName: 'Qwen 3.5 9B'
        })
      ),
    /proxyToken/
  )
})

test('handshake rejects a malformed proxy token', () => {
  assert.throws(() => parseHostListening(payload({ proxyToken: 'qvac' })), /proxyToken/)
})

test('handshake rejects a payload that is not JSON', () => {
  assert.throws(() => parseHostListening('{ not-json'), /not valid JSON/)
})

test('handshake never carries a managed serve key field', () => {
  const listening = parseHostListening(payload({ apiKey: 'b'.repeat(43) }))

  assert.deepEqual(Object.keys(listening).sort(), ['baseURL', 'modelId', 'modelName', 'proxyToken'])
  assert.doesNotMatch(JSON.stringify(listening), /b{43}/)
})

test('handshake formats a single prefixed line for the dedicated channel', () => {
  const line = formatHostListening(parseHostListening(payload()))

  assert.equal(HANDSHAKE_FD, 3)
  assert.ok(line.startsWith(HANDSHAKE_PREFIX))
  assert.ok(line.endsWith('\n'))
  assert.equal(line.trimEnd().split('\n').length, 1)
  assert.deepEqual(
    parseHostListening(line.slice(HANDSHAKE_PREFIX.length)),
    parseHostListening(payload())
  )
})

test('handshake is written to the given channel and fails closed without one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qvac-handshake-'))
  const path = join(dir, 'channel')
  const fd = openSync(path, 'w')
  try {
    writeHostListening(parseHostListening(payload()), fd)
    assert.equal(readFileSync(path, 'utf8'), formatHostListening(parseHostListening(payload())))
  } finally {
    closeSync(fd)
    rmSync(dir, { recursive: true, force: true })
  }

  // No handshake pipe: the host must fail rather than fall back to stdout.
  assert.throws(() => writeHostListening(parseHostListening(payload()), 99), {
    code: 'HOST_HANDSHAKE_CHANNEL_UNAVAILABLE'
  })
})

test('generated proxy tokens are unguessable 32-byte base64url strings', () => {
  const a = generateProxyToken()
  const b = generateProxyToken()

  assert.match(a, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(a, b)
})
