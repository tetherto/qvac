import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { CLI_BIN, configuredServer } from '../helpers/cli.js'
import { MODELLESS_CONFIG, writeConfigDir } from '../helpers/config.js'

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

  it('reports the port it bound with --port 0 on the ready descriptor', async (t) => {
    const dir = await writeConfigDir(t, MODELLESS_CONFIG)
    const proc = spawn(
      process.execPath,
      [CLI_BIN, 'serve', '--openai', '--no-default', '--port', '0', '--ready-fd', '3'],
      { cwd: dir, env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] }
    )
    t.after(() => {
      proc.kill('SIGTERM')
    })

    const lines = createInterface({ input: proc.stdio[3] as Readable })
    const [line] = (await once(lines, 'line')) as [string]
    const match = /^QVAC_SERVE_READY (\{.*\})$/.exec(line)
    assert.ok(match, `unexpected ready line: ${line}`)
    const { port, pid } = JSON.parse(match[1]!) as { port: number; pid: number }
    assert.equal(pid, proc.pid)
    assert.ok(port > 0)

    const res = await fetch(`http://127.0.0.1:${port}/v1/models`)
    assert.equal(res.status, 200)
  })
})
