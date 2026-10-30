import test from 'brittle'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function embedWith(t: { teardown: (fn: () => Promise<void>) => void }, worker: string) {
  process.env['QVAC_WORKER_PATH'] = path.resolve(__dirname, 'fixtures', worker)

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
  } catch (error) {
    return error as {
      name?: string
      exitCode?: number | null
      exitSignal?: string | null
      timedOut?: boolean
      cause?: { exitCode?: number | null; signalCode?: string | null }
    }
  }
  return undefined
}

test('a worker that exits before ready reports its exit code', async function (t) {
  t.timeout(15_000)

  const error = await embedWith(t, 'exit-before-ready-worker.mjs')

  t.is(error?.name, 'WORKER_STARTUP_FAILED')
  t.is(error?.exitCode, 7)
  t.is(error?.exitSignal, null)
  t.is(error?.timedOut, false)
  t.is(error?.cause?.exitCode, 7)
})

test('a worker that exits after ready reports its exit code', async function (t) {
  t.timeout(15_000)

  const error = await embedWith(t, 'exit-after-ready-worker.mjs')

  t.is(error?.name, 'WORKER_CRASHED')
  t.is(error?.exitCode, 7)
  t.is(error?.exitSignal, null)
})

test(
  'a worker killed after ready reports the signal',
  { skip: process.platform === 'win32' },
  async function (t) {
    t.timeout(15_000)

    const error = await embedWith(t, 'killed-after-ready-worker.mjs')

    t.is(error?.name, 'WORKER_CRASHED')
    t.is(error?.exitCode, null)
    t.is(error?.exitSignal, 'SIGKILL')
  }
)
