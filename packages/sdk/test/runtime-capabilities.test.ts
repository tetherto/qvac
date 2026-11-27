import test from 'brittle'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Real workers. The report comes from the worker's registered plugins, so the
// default worker and a whisper-only worker answer differently.

test('the default worker reports every QVAC contract, to the owner and to a session', async function (t) {
  t.timeout(30_000)

  delete process.env['QVAC_WORKER_PATH']

  const { getRuntimeCapabilities } = await import('@/client/api/get-runtime-capabilities')
  const { openSession } = await import('@/client/session')
  const { close } = await import('@/client/rpc/rpc-client')
  const { resetSessionRegistry } = await import('@/client/session-registry')

  t.teardown(async () => {
    resetSessionRegistry()
    await close()
  })

  const capabilities = await getRuntimeCapabilities()
  t.is(capabilities.length, 19, 'one entry per QVAC contract')
  t.ok(
    capabilities.every((capability) => capability.version === 1),
    'every contract is at major 1'
  )
  t.alike(
    capabilities.find((capability) => capability.id === 'transcription'),
    {
      id: 'transcription',
      version: 1,
      operations: ['transcribe'],
      partialOperations: ['transcribeStream']
    },
    'MOSS has no transcribeStream, so streaming is partial'
  )

  const session = openSession({ name: 'capabilities' })
  t.alike(await session.getRuntimeCapabilities(), capabilities, 'a session sees the same report')
  await session.close()
})

test('a worker with only whisper reports only transcription, streaming included', async function (t) {
  t.timeout(30_000)

  process.env['QVAC_WORKER_PATH'] = path.resolve(
    __dirname,
    'fixtures/transcription-only-worker.mjs'
  )

  const { getRuntimeCapabilities } = await import('@/client/api/get-runtime-capabilities')
  const { close } = await import('@/client/rpc/rpc-client')

  t.teardown(async () => {
    await close()
    delete process.env['QVAC_WORKER_PATH']
  })

  t.alike(await getRuntimeCapabilities(), [
    {
      id: 'transcription',
      version: 1,
      operations: ['transcribe', 'transcribeStream'],
      partialOperations: []
    }
  ])
})
