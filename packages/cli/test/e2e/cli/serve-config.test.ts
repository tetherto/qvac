import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { startCliServer } from '../helpers/cli.js'
import { writeConfigDir, MODELLESS_CONFIG } from '../helpers/config.js'

// Confirm the serve flags actually change server behavior over the real socket,
// not just that they parse. Modelless, so each case spawns a fresh binary cheaply.

describe('serve flags: --api-key', () => {
  it('rejects requests without/with a wrong key and accepts the configured one', async (t) => {
    const dir = await writeConfigDir(t, MODELLESS_CONFIG)
    const srv = await startCliServer(t, ['--api-key', 'secret-key-123'], { cwd: dir })

    const noAuth = await fetch(`${srv.baseUrl}/v1/models`)
    assert.equal(noAuth.status, 401)
    assert.equal(((await noAuth.json()) as { error?: { code?: string } }).error?.code, 'invalid_api_key')

    const wrong = await fetch(`${srv.baseUrl}/v1/models`, { headers: { authorization: 'Bearer nope' } })
    assert.equal(wrong.status, 401)

    const ok = await fetch(`${srv.baseUrl}/v1/models`, { headers: { authorization: 'Bearer secret-key-123' } })
    assert.equal(ok.status, 200)
    assert.equal(((await ok.json()) as { object: string }).object, 'list')
  })

  it('serves without authentication when no key is set', async (t) => {
    const dir = await writeConfigDir(t, MODELLESS_CONFIG)
    const srv = await startCliServer(t, [], { cwd: dir })
    assert.equal((await fetch(`${srv.baseUrl}/v1/models`)).status, 200)
  })
})

describe('serve flags: --cors', () => {
  it('sets the CORS origin header only when enabled', async (t) => {
    const onDir = await writeConfigDir(t, MODELLESS_CONFIG)
    const on = await startCliServer(t, ['--cors'], { cwd: onDir })
    const resOn = await fetch(`${on.baseUrl}/v1/models`)
    assert.ok(resOn.headers.get('access-control-allow-origin'), 'expected CORS header with --cors')

    const offDir = await writeConfigDir(t, MODELLESS_CONFIG)
    const off = await startCliServer(t, [], { cwd: offDir })
    const resOff = await fetch(`${off.baseUrl}/v1/models`)
    assert.equal(resOff.headers.get('access-control-allow-origin'), null, 'expected no CORS header by default')
  })
})

describe('serve flags: --docs', () => {
  it('exposes Swagger UI at /docs only when enabled; /openapi.json is always served', async (t) => {
    const onDir = await writeConfigDir(t, MODELLESS_CONFIG)
    const on = await startCliServer(t, ['--docs'], { cwd: onDir })
    assert.ok((await fetch(`${on.baseUrl}/docs`)).ok, 'expected /docs to be served with --docs')
    assert.equal((await fetch(`${on.baseUrl}/openapi.json`)).status, 200)

    const offDir = await writeConfigDir(t, MODELLESS_CONFIG)
    const off = await startCliServer(t, [], { cwd: offDir })
    assert.equal((await fetch(`${off.baseUrl}/docs`)).status, 404)
    assert.equal((await fetch(`${off.baseUrl}/openapi.json`)).status, 200)
  })
})
