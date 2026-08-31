import assert from 'node:assert/strict'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { resolveServeApiKey } from '@/serve/api-key'
import { createCorsOriginMatcher, isLoopbackHost, normalizeCorsOrigin } from '@/serve/cors'
import { parseServeConfig } from '@/serve/config'
import { buildServer } from '@/serve/index'
import { checkNetworkExposure, ServeOptionsError, validateServeStartup } from '@/serve/startup'

describe('normalizeCorsOrigin', () => {
  it('normalizes HTTP(S) origins', () => {
    assert.equal(normalizeCorsOrigin(' HTTPS://Example.COM:443/ '), 'https://example.com')
    assert.equal(normalizeCorsOrigin('http://Example.COM:8080/'), 'http://example.com:8080')
  })

  it('rejects wildcard and path origins', () => {
    assert.throws(() => normalizeCorsOrigin('*'), /wildcard/i)
    assert.throws(() => normalizeCorsOrigin('https://example.com/path'), /origin/i)
  })

  it('rejects non-HTTP origins and URL components outside an origin', () => {
    assert.throws(() => normalizeCorsOrigin('file:///tmp/example'), /http/i)
    assert.throws(() => normalizeCorsOrigin('https://user@example.com'), /origin/i)
    assert.throws(() => normalizeCorsOrigin('https://example.com/?query=yes'), /origin/i)
    assert.throws(() => normalizeCorsOrigin('https://example.com/#fragment'), /origin/i)
  })
})

describe('isLoopbackHost', () => {
  it('recognizes localhost and IP loopback hosts', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'api.localhost',
      '127.0.0.1',
      '127.42.0.9',
      '::1',
      '[::1]'
    ]) {
      assert.equal(isLoopbackHost(host), true, `expected ${host} to be loopback`)
    }
  })

  it('rejects non-loopback hosts', () => {
    for (const host of [
      'example.com',
      'localhost.example.com',
      '0.0.0.0',
      '127.0.0.256',
      '192.168.1.2',
      '::'
    ]) {
      assert.equal(isLoopbackHost(host), false, `expected ${host} not to be loopback`)
    }
  })
})

describe('createCorsOriginMatcher', () => {
  it('allows requests without an Origin and exact normalized matches', () => {
    const matcher = createCorsOriginMatcher(['https://example.com', 'http://localhost:3000'])

    matcher(undefined, (error, allowed) => {
      assert.equal(error, null)
      assert.equal(allowed, true)
    })
    matcher('HTTPS://EXAMPLE.COM:443/', (error, allowed) => {
      assert.equal(error, null)
      assert.equal(allowed, true)
    })
  })

  it('rejects origins outside the allowlist', () => {
    const matcher = createCorsOriginMatcher(['https://example.com'])

    matcher('https://attacker.example', (error, allowed) => {
      assert.equal(error, null)
      assert.equal(allowed, false)
    })
  })
})

describe('serve.cors.origins', () => {
  it('normalizes and deduplicates configured and CLI origins', () => {
    const config = parseServeConfig(
      {
        serve: {
          cors: {
            origins: [' HTTPS://Example.COM:443/ ', 'http://localhost:3000']
          }
        }
      },
      {
        corsOrigins: ['https://example.com', 'https://other.example']
      }
    )

    assert.deepEqual(config.cors.origins, [
      'https://example.com',
      'http://localhost:3000',
      'https://other.example'
    ])
  })

  it('rejects invalid configured origin collections', () => {
    assert.throws(
      () =>
        parseServeConfig(
          {
            serve: {
              cors: {
                origins: 'https://example.com'
              }
            }
          },
          {}
        ),
      /serve\.cors\.origins must be an array/i
    )
  })
})

describe('serve startup validation', () => {
  it('rejects --cors without an explicit trusted origin', () => {
    assert.throws(
      () => validateServeStartup([], { cors: true, port: 11434 }),
      (error: unknown) => {
        assert.ok(error instanceof ServeOptionsError)
        assert.equal(error.name, 'ServeOptionsError')
        assert.equal(error.option, '--cors')
        assert.match(error.message, /--cors-origin|serve\.cors\.origins/)
        return true
      }
    )
    validateServeStartup(['https://example.com'], { cors: true, port: 11434 })
  })

  it('rejects --docs with an ephemeral port', () => {
    // The docs allowlist is derived from the configured port, so `--port 0`
    // would produce `http://localhost:0` — an origin no browser can ever send.
    assert.throws(
      () => validateServeStartup([], { docs: true, port: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof ServeOptionsError)
        assert.equal(error.option, '--docs')
        assert.match(error.message, /--port/)
        return true
      }
    )
    validateServeStartup([], { docs: true, port: 11434 })
    validateServeStartup([], { port: 0 })
  })
})

describe('network exposure', () => {
  it('refuses an unauthenticated non-loopback bind', () => {
    assert.throws(
      () => checkNetworkExposure({ host: '0.0.0.0' }),
      (error: unknown) => {
        assert.ok(error instanceof ServeOptionsError)
        assert.equal(error.option, '--host')
        assert.match(error.message, /--api-key|--api-key-file/)
        assert.match(error.message, /--allow-unauthenticated/)
        return true
      }
    )
  })

  it('permits a non-loopback bind that is authenticated or explicitly opted in', () => {
    assert.equal(checkNetworkExposure({ host: '0.0.0.0', apiKey: 'secret' }), undefined)
    assert.equal(checkNetworkExposure({ host: '127.0.0.1' }), undefined)
    assert.match(
      checkNetworkExposure({ host: '0.0.0.0', allowUnauthenticated: true }) ?? '',
      /Security warning.*0\.0\.0\.0/s
    )
  })

  it('refuses before preload or listen', async () => {
    // buildServer runs before startServer's preload/listen, so failing here
    // necessarily precedes the socket accepting connections.
    await assert.rejects(
      buildServer({ projectRoot: tmpdir(), port: 0, host: '0.0.0.0' }),
      (error: unknown) => {
        assert.ok(error instanceof ServeOptionsError)
        assert.equal(error.option, '--host')
        return true
      }
    )
  })

  it('warns rather than refuses once the operator opts in', async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }
    let app
    try {
      app = await buildServer({
        projectRoot: tmpdir(),
        port: 0,
        host: '0.0.0.0',
        allowUnauthenticated: true
      })
    } finally {
      console.warn = originalWarn
    }
    try {
      assert.ok(
        warnings.some((line) => /Security warning: binding to non-loopback host/.test(line)),
        `expected an exposure warning, got: ${warnings.join(' | ')}`
      )
    } finally {
      await app.close()
    }
  })
})

describe('resolveServeApiKey', () => {
  function withKeyFile(contents: string, mode: number): string {
    const dir = mkdtempSync(join(tmpdir(), 'qvac-serve-key-'))
    const path = join(dir, 'api-key')
    writeFileSync(path, contents, { mode })
    return path
  }

  it('reads the key from a file so it never reaches argv', () => {
    const path = withKeyFile('  file-sourced-key\n', 0o600)
    assert.deepEqual(resolveServeApiKey({ apiKeyFile: path }), {
      apiKey: 'file-sourced-key',
      warning: undefined
    })
  })

  it('passes through an inline key and the absent case unchanged', () => {
    assert.deepEqual(resolveServeApiKey({ apiKey: 'inline' }), {
      apiKey: 'inline',
      warning: undefined
    })
    assert.deepEqual(resolveServeApiKey({}), { apiKey: undefined, warning: undefined })
  })

  it('refuses both key sources at once', () => {
    const path = withKeyFile('k', 0o600)
    assert.throws(
      () => resolveServeApiKey({ apiKey: 'inline', apiKeyFile: path }),
      (error: unknown) => {
        assert.ok(error instanceof ServeOptionsError)
        assert.match(error.message, /mutually exclusive/)
        return true
      }
    )
  })

  it('refuses a missing or empty key file', () => {
    assert.throws(
      () => resolveServeApiKey({ apiKeyFile: join(tmpdir(), 'qvac-absent-key-file') }),
      /cannot read the API key file/
    )
    assert.throws(() => resolveServeApiKey({ apiKeyFile: withKeyFile('  \n', 0o600) }), /is empty/)
  })

  it('refuses a key path that is not a regular file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qvac-serve-key-'))
    assert.throws(() => resolveServeApiKey({ apiKeyFile: dir }), /must be a regular file/)

    const target = withKeyFile('linked', 0o600)
    const link = join(dir, 'link-to-key')
    symlinkSync(target, link)
    assert.throws(() => resolveServeApiKey({ apiKeyFile: link }), /must be a regular file/)
  })

  it('warns when the key file is readable beyond its owner', function (t) {
    if (process.platform === 'win32') {
      t.skip('POSIX mode bits')
      return
    }
    const resolved = resolveServeApiKey({ apiKeyFile: withKeyFile('loose', 0o644) })
    assert.equal(resolved.apiKey, 'loose')
    assert.match(resolved.warning ?? '', /readable beyond its owner/)
  })
})

describe('trailing-dot origins', () => {
  it('rejects a root-label hostname that no browser would ever send', () => {
    assert.throws(() => normalizeCorsOrigin('https://example.com./'), /trailing dot/)
    // The matcher swallows unparseable inbound origins rather than allowing them.
    const match = createCorsOriginMatcher(['https://example.com'])
    let allowed: boolean | undefined
    match('https://example.com.', (_err, result) => {
      allowed = result
    })
    assert.equal(allowed, false)
  })
})
