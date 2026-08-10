import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { describe, it } from 'node:test'
import { createCorsOriginMatcher, isLoopbackHost, normalizeCorsOrigin } from '../src/serve/cors.js'
import { parseServeConfig } from '../src/serve/config.js'
import { buildServer } from '../src/serve/index.js'
import {
  networkExposureWarning,
  ServeOptionsError,
  validateServeStartup
} from '../src/serve/startup.js'

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

describe('network exposure warning', () => {
  it('warns only for a non-loopback bind without an API key', () => {
    assert.match(
      networkExposureWarning({ host: '0.0.0.0' }) ?? '',
      /Security warning.*0\.0\.0\.0.*--api-key/s
    )
    assert.equal(networkExposureWarning({ host: '0.0.0.0', apiKey: 'secret' }), undefined)
    assert.equal(networkExposureWarning({ host: '127.0.0.1' }), undefined)
  })

  it('is emitted while options are resolved, before preload or listen', async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }
    let app
    try {
      // buildServer runs before startServer's preload/listen, so a warning
      // observed here necessarily precedes the socket accepting connections.
      app = await buildServer({ projectRoot: tmpdir(), port: 0, host: '0.0.0.0' })
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
