import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('serve startup network exposure', () => {
  it('refuses to bind beyond loopback without an API key', async () => {
    const result = await runCli(['serve', 'openai', '--host', '0.0.0.0'], { timeoutMs: 5_000 })
    assert.equal(result.code, 1)
    assert.match(result.output, /non-loopback/i)
    assert.match(result.output, /--api-key|--api-key-file/)
    assert.match(result.output, /--allow-unauthenticated/)
  })

  it('warns but starts once the operator opts in', async (t) => {
    const server = await configuredServer(t, MODELLESS_CONFIG, [
      '--host',
      '0.0.0.0',
      '--allow-unauthenticated'
    ])
    assert.match(server.output(), /non-loopback|api key|--api-key/i)
  })
})

describe('serve flags: --api-key-file', () => {
  it('authenticates with a key read from a file instead of argv', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'qvac-cli-key-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const keyFile = join(dir, 'api-key')
    await writeFile(keyFile, 'file-sourced-key-123\n', { mode: 0o600 })

    const srv = await configuredServer(t, MODELLESS_CONFIG, ['--api-key-file', keyFile])

    assert.equal((await fetch(`${srv.baseUrl}/v1/models`)).status, 401)
    const authed = await fetch(`${srv.baseUrl}/v1/models`, {
      headers: { authorization: 'Bearer file-sourced-key-123' }
    })
    assert.equal(authed.status, 200)
  })

  it('refuses a key file that is missing or not a regular file', async () => {
    const missing = await runCli(
      ['serve', 'openai', '--api-key-file', join(tmpdir(), 'qvac-absent')],
      {
        timeoutMs: 5_000
      }
    )
    assert.equal(missing.code, 1)
    assert.match(missing.output, /cannot read the API key file/)

    const dir = await mkdtemp(join(tmpdir(), 'qvac-cli-key-'))
    try {
      const asDir = await runCli(['serve', 'openai', '--api-key-file', dir], { timeoutMs: 5_000 })
      assert.equal(asDir.code, 1)
      assert.match(asDir.output, /must be a regular file/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
