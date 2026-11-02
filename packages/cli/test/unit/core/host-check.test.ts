import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createHostMatcher, normalizeAllowedHost } from '@/serve/core/host-check'
import { parseServeConfig } from '@/serve/core/config'

describe('createHostMatcher', () => {
  const allowed = createHostMatcher({ bindHost: '127.0.0.1', allowedHosts: [] })

  it('accepts loopback names and IP literals, with or without a port', () => {
    for (const host of [
      'localhost',
      'localhost:11434',
      'LOCALHOST.',
      'app.localhost:8080',
      '127.0.0.1',
      '127.0.0.1:11434',
      '[::1]:11434',
      '192.168.1.20:11434',
      '[fe80::1]'
    ]) {
      assert.equal(allowed(host), true, host)
    }
  })

  it('rejects other hostnames, including rebinding-style names', () => {
    for (const host of [
      'attacker.example',
      'attacker.example:11434',
      'localhost.attacker.example',
      '127.0.0.1.nip.io',
      'evil.com@127.0.0.1',
      '',
      undefined
    ]) {
      assert.equal(allowed(host), false, String(host))
    }
  })

  it('accepts the bind host, the public base URL host and listed names', () => {
    const matcher = createHostMatcher({
      bindHost: 'qvac.lan',
      allowedHosts: ['api.internal', '.corp.example'],
      publicBaseUrl: 'https://qvac.example.com'
    })
    for (const host of [
      'qvac.lan:11434',
      'qvac.example.com',
      'API.internal',
      'corp.example',
      'gpu.corp.example:443'
    ]) {
      assert.equal(matcher(host), true, host)
    }
    assert.equal(matcher('notcorp.example'), false)
    assert.equal(matcher('attacker.example'), false)
  })

  it('accepts a bare IPv6 bind address', () => {
    assert.equal(createHostMatcher({ bindHost: '::1', allowedHosts: [] })('[::1]:1'), true)
  })

  it('accepts any host when allowedHosts is true', () => {
    assert.equal(createHostMatcher({ bindHost: '127.0.0.1', allowedHosts: true })('a.b'), true)
  })
})

describe('normalizeAllowedHost', () => {
  it('lowercases and drops a trailing dot', () => {
    assert.equal(normalizeAllowedHost(' API.Example. '), 'api.example')
    assert.equal(normalizeAllowedHost('.Example.com'), '.example.com')
  })

  it('rejects wildcards, schemes, ports and paths', () => {
    for (const entry of ['*', '*.example.com', 'http://example.com', 'example.com:80', 'a/b', '']) {
      assert.throws(() => normalizeAllowedHost(entry), /Allowed host/, entry)
    }
  })
})

describe('parseServeConfig allowedHosts', () => {
  it('merges config and CLI hosts', () => {
    const config = parseServeConfig(
      { serve: { allowedHosts: ['A.example'] } },
      { allowedHosts: ['b.example', 'a.example'] }
    )
    assert.deepEqual(config.allowedHosts, ['a.example', 'b.example'])
  })

  it('defaults to no extra hosts', () => {
    assert.deepEqual(parseServeConfig({}, {}).allowedHosts, [])
  })

  it('opts out from --allow-any-host or serve.allowedHosts: true', () => {
    assert.equal(parseServeConfig({}, { allowAnyHost: true }).allowedHosts, true)
    assert.equal(parseServeConfig({ serve: { allowedHosts: true } }, {}).allowedHosts, true)
  })

  it('rejects a malformed serve.allowedHosts', () => {
    assert.throws(() => parseServeConfig({ serve: { allowedHosts: 'x' } }, {}), /allowedHosts/)
    assert.throws(() => parseServeConfig({ serve: { allowedHosts: [1] } }, {}), /allowedHosts\[0\]/)
  })
})
