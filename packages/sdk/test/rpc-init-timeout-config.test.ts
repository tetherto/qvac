import test from 'brittle'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.resolve(__dirname, '../dist/src/client/rpc/node-rpc-client.js')
const CONFIGURED_TIMEOUT_MS = 1_500

// The default is 60 s. A worker that never signals ready would sit there for
// all of it, so failing early is itself the evidence that the config took effect.
void test('worker startup honours rpcInitTimeoutMs from the config', async function (t) {
  t.timeout(20_000)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-init-timeout-'))
  const configPath = path.join(dir, 'qvac.config.json')
  fs.writeFileSync(configPath, JSON.stringify({ rpcInitTimeoutMs: CONFIGURED_TIMEOUT_MS }))
  process.env['QVAC_CONFIG_PATH'] = configPath
  process.env['QVAC_WORKER_PATH'] = path.resolve(__dirname, 'fixtures/silent-worker.mjs')

  const { getRPC, close } = (await import(
    pathToFileURL(CLIENT).href
  )) as typeof import('@/client/rpc/node-rpc-client')

  t.teardown(async function () {
    try {
      await close()
    } catch {}
    delete process.env['QVAC_CONFIG_PATH']
    delete process.env['QVAC_WORKER_PATH']
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const startedAt = Date.now()
  let thrown: unknown
  try {
    await getRPC()
    t.fail('getRPC() resolved, but the fixture worker never signals ready')
  } catch (error) {
    thrown = error
  }
  const elapsedMs = Date.now() - startedAt

  const failure = thrown as { name?: string; timedOut?: boolean }
  t.is(failure.name, 'WORKER_STARTUP_FAILED', `expected a startup failure, got ${String(thrown)}`)
  t.is(failure.timedOut, true)
  t.ok(elapsedMs < 15_000, `expected the configured timeout to fire early, took ${elapsedMs}ms`)
})
