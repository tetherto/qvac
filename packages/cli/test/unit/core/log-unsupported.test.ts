import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import createHttpServer from '@/lib/http'
import { logUnsupported } from '@/lib/api/core/plugins/log-unsupported'
import type { Logger } from '@/lib/logger'
import type { QvacContext } from '@/lib/api/core/context'

function warningContext(warnings: string[]): QvacContext {
  const logger: Logger = {
    error() {},
    info() {},
    debug() {},
    warn(message) {
      warnings.push(message)
    }
  }
  return { logger } as QvacContext
}

describe('unsupported parameter warnings', () => {
  it('reports field names without retaining private values or injecting log lines', async (t) => {
    const warnings: string[] = []
    const app = createHttpServer()
    t.after(() => app.close())
    app.decorate('qvac', warningContext(warnings))
    app.post<{ Body: Record<string, unknown> }>(
      '/warnings',
      {
        config: { unsupportedParams: ['user', 'instructions', 'stop', 'reasoning'] },
        preHandler: logUnsupported
      },
      // lunte-disable-next-line require-await
      async (req) => req.body
    )
    const payload = {
      user: 'private-person@example.invalid\nforged log line',
      instructions: 'Private meeting notes '.repeat(10_000),
      stop: ['private stop text'],
      reasoning: { privateMetadata: 'confidential work context' },
      supported: 'still forwarded'
    }

    const response = await app.inject({ method: 'POST', url: '/warnings', payload })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), payload, 'logging must not alter the request body')
    assert.deepEqual(warnings, [
      'Ignoring unsupported param: user',
      'Ignoring unsupported param: instructions',
      'Ignoring unsupported param: stop',
      'Ignoring unsupported param: reasoning'
    ])
  })

  it('warns for supplied falsy values and stays quiet for absent fields', async (t) => {
    const warnings: string[] = []
    const app = createHttpServer()
    t.after(() => app.close())
    app.decorate('qvac', warningContext(warnings))
    app.post(
      '/warnings',
      {
        config: { unsupportedParams: ['empty', 'zero', 'disabled', 'null', 'absent'] },
        preHandler: logUnsupported
      },
      // lunte-disable-next-line require-await
      async () => ({ ok: true })
    )

    const response = await app.inject({
      method: 'POST',
      url: '/warnings',
      payload: { empty: '', zero: 0, disabled: false, null: null }
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(warnings, [
      'Ignoring unsupported param: empty',
      'Ignoring unsupported param: zero',
      'Ignoring unsupported param: disabled',
      'Ignoring unsupported param: null'
    ])
  })
})
