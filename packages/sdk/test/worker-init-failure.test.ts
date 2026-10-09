import test from 'brittle'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

test('an SDK call rejects with SET_CONFIG_FAILED when the worker cannot apply its init config', async function (t) {
  t.timeout(15_000)

  process.env['QVAC_WORKER_PATH'] = path.resolve(__dirname, 'fixtures/init-failure-worker.mjs')

  const { embed } = await import('@/client/api/embed')
  const { close } = await import('@/client/rpc/rpc-client')

  t.teardown(async () => {
    try {
      await close()
    } catch {}
    delete process.env['QVAC_WORKER_PATH']
  })

  try {
    await embed({ modelId: 'irrelevant', text: 'hi' })
    t.fail('expected embed() to reject')
  } catch (error) {
    t.is((error as { name?: string }).name, 'SET_CONFIG_FAILED')
    t.ok((error as Error).message.includes('initialize failed'))
  }
})
