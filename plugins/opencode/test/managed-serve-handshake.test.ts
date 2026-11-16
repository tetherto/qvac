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

test('handshake carries the proxy token into the V2 provider settings', () => {
  const listening = parseHostListening(payload())

  const { info } = createManagedProviderConfig(listening, {
    readyTimeoutMs: 123_000,
    ctxSize: 32768
  })

  assert.equal(info.id, 'qvac')
  assert.equal(info.activation, 'enabled')
  assert.equal(info.package, '@opencode/ai/providers/openai-compatible')
  assert.equal(info.settings?.['apiKey'], proxyToken)
  assert.equal(info.settings?.['baseURL'], 'http://127.0.0.1:12345/v1')
  assert.equal(info.settings?.timeout, 123_000)
})

test('provider config exposes the managed model with tools and the serve context window', () => {
  const listening = parseHostListening(payload())

  const { models } = createManagedProviderConfig(listening, { readyTimeoutMs: 1, ctxSize: 16384 })

  assert.equal(models.length, 1)
  const [model] = models
  assert.equal(model?.id, 'qwen3.5-9b')
  assert.equal(model?.providerID, 'qvac')
  assert.equal(model?.name, 'Qwen 3.5 9B (local)')
  assert.equal(model?.capabilities.tools, true)
  assert.equal(model?.limit.context, 16384)
  assert.ok((model?.limit.output ?? Infinity) <= 16384)
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
