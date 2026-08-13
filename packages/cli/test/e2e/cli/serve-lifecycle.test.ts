import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { configuredServer } from '../helpers/cli.js'
import { MODELLESS_CONFIG } from '../helpers/config.js'

// Real-socket fidelity that app.inject can't reach: the built binary actually
// binds a port and serves, and shuts down on a signal. (Streaming/cancel
// fidelity needs a model and lives in the real-model suite.)
describe('serve: lifecycle (spawned binary)', () => {
  it('binds a real port and answers /v1/models over the socket', async (t) => {
    const origin = 'https://trusted.example'
    const srv = await configuredServer(t, MODELLESS_CONFIG, ['--cors', '--cors-origin', origin])

    const res = await fetch(`${srv.baseUrl}/v1/models`, { headers: { origin } })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { object: string; data: unknown[] }
    assert.equal(body.object, 'list')
    // CORS header travels over the real transport (set by @fastify/cors).
    assert.equal(res.headers.get('access-control-allow-origin'), origin)
  })

  it('shuts down on SIGTERM', async (t) => {
    const srv = await configuredServer(t, MODELLESS_CONFIG, [])

    srv.proc.kill('SIGTERM')
    const [code, signal] = (await once(srv.proc, 'close')) as [number | null, string | null]
    assert.ok(
      code === 0 || signal === 'SIGTERM',
      `expected clean shutdown, got code=${code} signal=${signal}`
    )
  })

  // The real server logs the volatile-store banner at startup (the in-process
  // suite checks the banner string but not that it is actually emitted).
  it('logs the volatile responses-store banner at startup', async (t) => {
    const srv = await configuredServer(t, MODELLESS_CONFIG, [])
    const deadline = Date.now() + 5000
    while (!/responses: in-memory only/.test(srv.output()) && Date.now() < deadline) await sleep(50)
    assert.match(srv.output(), /responses: in-memory only/)
  })
})
