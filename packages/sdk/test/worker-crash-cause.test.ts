import test from 'brittle'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

test('WORKER_CRASHED carries the worker error as its cause', async function (t) {
  t.timeout(15_000)

  process.env['QVAC_WORKER_PATH'] = path.resolve(__dirname, 'fixtures/throwing-worker.mjs')

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
    t.is((error as { name?: string }).name, 'WORKER_CRASHED')
    const cause = (error as { cause?: unknown }).cause
    t.ok(cause instanceof Error && cause.message.includes('QVAC_TEST_WORKER_THREW'))
  }
})
