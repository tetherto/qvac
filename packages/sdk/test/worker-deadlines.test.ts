import test from 'brittle'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// A real worker whose only plugin stalls. The deadlines travel in
// `rpcOptions.deadline`, the worker enforces them, and the error comes back as
// the SDK's own `DeadlineExceededError` class.

test('the worker fails a stalled call at its deadline and reports the boundary', async function (t) {
  t.timeout(60_000)

  process.env['QVAC_WORKER_PATH'] = path.resolve(__dirname, 'fixtures/stall-worker.mjs')
  const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-stall-model-'))
  const modelPath = path.join(modelDir, 'model.bin')
  fs.writeFileSync(modelPath, '')

  const { loadModel } = await import('@/client/api/load-model')
  const { invokePlugin, invokePluginStream } = await import('@/client/api/invoke-plugin')
  const { close } = await import('@/client/rpc/rpc-client')
  const { DeadlineExceededError } = await import('@/index')

  t.teardown(async () => {
    await close()
    delete process.env['QVAC_WORKER_PATH']
    fs.rmSync(modelDir, { recursive: true, force: true })
  })

  const modelId = await loadModel({ modelType: 'deadline-stall-test', modelSrc: modelPath })

  async function failure(work: Promise<unknown>) {
    try {
      await work
    } catch (error) {
      if (error instanceof DeadlineExceededError) return error
      throw error
    }
    throw new Error('expected the call to fail on its deadline')
  }

  const stalled = invokePluginStream<{ n: number }>(
    { modelId, handler: 'stall', params: {} },
    { deadline: { idleMs: 300 } }
  )
  t.is((await stalled.next()).value?.n, 1, 'the first chunk arrives')
  const idle = await failure(stalled.next())
  t.is(idle.boundary, 'idle')
  t.is(idle.timeoutMs, 300)
  t.is(idle.requestId, stalled.requestId)
  t.is(idle.modelId, modelId)
  t.is(idle.code, 52425)

  const ignoring = invokePluginStream<{ n: number }>(
    { modelId, handler: 'stallIgnoringAbort', params: { key: 'stream' } },
    { deadline: { idleMs: 300 } }
  )
  await ignoring.next()
  t.is(
    (await failure(ignoring.next())).boundary,
    'idle',
    'a handler that ignores the abort does not delay the error'
  )

  const started = Date.now()
  const run = await failure(
    invokePlugin(
      { modelId, handler: 'hang', params: { key: 'reply' } },
      { deadline: { runMs: 300 } }
    )
  )
  t.is(run.boundary, 'run')
  t.ok(Date.now() - started < 5_000, 'the caller did not wait for the handler')

  for (const key of ['stream', 'reply']) {
    await invokePlugin({ modelId, handler: 'release', params: { key } })
  }
})
