import test from 'brittle'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RPC_INIT_TIMEOUT_ENV_VAR } from '@/client/rpc/init-timeout'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIGURED_TIMEOUT_MS = 1_500

// The default is 30s. A worker that never connects would sit there for all of
// it, so finishing early is itself the evidence that the override took effect.
void test('RPC init honours a configured timeout instead of the 30s default', async function (t) {
  t.timeout(20_000)

  process.env['QVAC_WORKER_PATH'] = path.resolve(__dirname, 'fixtures/silent-worker.mjs')
  process.env[RPC_INIT_TIMEOUT_ENV_VAR] = String(CONFIGURED_TIMEOUT_MS)

  const { getRPC, close } = await import('@/client/rpc/node-rpc-client')

  t.teardown(async function () {
    try {
      await close()
    } catch {}
    delete process.env['QVAC_WORKER_PATH']
    delete process.env[RPC_INIT_TIMEOUT_ENV_VAR]
  })

  const startedAt = Date.now()
  let thrown: Error | undefined
  try {
    await getRPC()
    t.fail('getRPC() resolved unexpectedly - the fixture worker never connects')
  } catch (error) {
    thrown = error as Error
  }
  const elapsedMs = Date.now() - startedAt

  t.is(thrown?.name, 'RPC_INIT_TIMEOUT')
  t.ok(
    thrown?.message.includes(`${CONFIGURED_TIMEOUT_MS}ms`),
    `expected the configured timeout in the message, got: ${thrown?.message}`
  )
  t.ok(elapsedMs < 15_000, `expected the timer to fire early, took ${elapsedMs}ms`)
})
