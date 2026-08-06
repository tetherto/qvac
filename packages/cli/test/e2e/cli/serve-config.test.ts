import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { configuredServer, runCli } from '../helpers/cli.js'
import { MODELLESS_CONFIG } from '../helpers/config.js'

// Confirm the serve flags actually change server behavior over the real socket,
// not just that they parse. Modelless, so each case spawns a fresh binary cheaply.

describe('serve flags: --api-key', () => {
  it('rejects requests without/with a wrong key and accepts the configured one', async (t) => {
    const srv = await configuredServer(t, MODELLESS_CONFIG, ['--api-key', 'secret-key-123'])

    const noAuth = await fetch(`${srv.baseUrl}/v1/models`)
    assert.equal(noAuth.status, 401)
    assert.equal(
      ((await noAuth.json()) as { error?: { code?: string } }).error?.code,
      'invalid_api_key'
    )

    const wrong = await fetch(`${srv.baseUrl}/v1/models`, {
      headers: { authorization: 'Bearer nope' }
    })
    assert.equal(wrong.status, 401)

    const ok = await fetch(`${srv.baseUrl}/v1/models`, {
      headers: { authorization: 'Bearer secret-key-123' }
    })
    assert.equal(ok.status, 200)
    assert.equal(((await ok.json()) as { object: string }).object, 'list')
  })

  it('serves without authentication when no key is set', async (t) => {
    const srv = await configuredServer(t, MODELLESS_CONFIG, [])
    assert.equal((await fetch(`${srv.baseUrl}/v1/models`)).status, 200)
  })
})

describe('serve flags: --cors', () => {
  it('allows configured and repeated CLI origins but rejects arbitrary origins', async (t) => {
    const server = await configuredServer(
      t,
      {
        ...MODELLESS_CONFIG,
        serve: {
          ...MODELLESS_CONFIG.serve,
          cors: { origins: ['https://configured.example'] }
        }
      },
      ['--cors', '--cors-origin', 'https://cli.example', '--cors-origin', 'https://second.example']
    )

    for (const origin of [
      'https://configured.example',
      'https://cli.example',
      'https://second.example'
    ]) {
      const response = await fetch(`${server.baseUrl}/v1/models`, { headers: { origin } })
      assert.equal(response.headers.get('access-control-allow-origin'), origin)
    }

    const denied = await fetch(`${server.baseUrl}/v1/models`, {
      headers: { origin: 'https://attacker.example' }
    })
    assert.equal(denied.headers.get('access-control-allow-origin'), null)
  })

  it('rejects --cors without an explicit origin', async () => {
    const result = await runCli(['serve', 'openai', '--cors'], { timeoutMs: 5_000 })
    assert.equal(result.code, 1)
    assert.match(result.output, /--cors.*--cors-origin|serve\.cors\.origins/i)
  })
})

describe('serve flags: --docs', () => {
  it('exposes Swagger UI at /docs only when enabled; /openapi.json is always served', async (t) => {
    const on = await configuredServer(t, MODELLESS_CONFIG, ['--docs'])
    assert.ok((await fetch(`${on.baseUrl}/docs`)).ok, 'expected /docs to be served with --docs')
    assert.equal((await fetch(`${on.baseUrl}/openapi.json`)).status, 200)

    const off = await configuredServer(t, MODELLESS_CONFIG, [])
    assert.equal((await fetch(`${off.baseUrl}/docs`)).status, 404)
    assert.equal((await fetch(`${off.baseUrl}/openapi.json`)).status, 200)
  })

  it('allows loopback browser origins and rejects remote origins', async (t) => {
    const server = await configuredServer(t, MODELLESS_CONFIG, ['--docs'])
    const loopbackOrigin = `http://localhost:${server.port}`

    const allowed = await fetch(`${server.baseUrl}/v1/models`, {
      headers: { origin: loopbackOrigin }
    })
    assert.equal(allowed.headers.get('access-control-allow-origin'), loopbackOrigin)

    const denied = await fetch(`${server.baseUrl}/v1/models`, {
      headers: { origin: 'https://remote.example' }
    })
    assert.equal(denied.headers.get('access-control-allow-origin'), null)
  })
})

describe('serve startup security warning', () => {
  it('warns when binding beyond loopback without an API key', async (t) => {
    const server = await configuredServer(t, MODELLESS_CONFIG, ['--host', '0.0.0.0'])
    assert.match(server.output(), /non-loopback|api key|--api-key/i)
  })
})
