import test from 'brittle'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import stow from 'bare-stow'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function bundleWorker(
  t: { ok: (value: unknown) => void; teardown: (fn: () => void) => void },
  fixture: string
): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(__dirname, 'tmp-bundled-worker-'))
  t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const outDir = path.join(tmpDir, 'worker')
  const entry = path.join(__dirname, 'fixtures', fixture)
  for await (const artifact of stow(
    pathToFileURL(entry).href,
    'bare-sidecar',
    pathToFileURL(outDir).href,
    { hosts: [`${process.platform}-${process.arch}`] }
  )) {
    t.ok(artifact.url)
  }
  return outDir
}

test('QVAC_WORKER_PATH naming a bundled worker folder starts it through its harness', async function (t) {
  t.timeout(60_000)

  process.env['QVAC_WORKER_PATH'] = await bundleWorker(t, 'init-failure-worker.mjs')

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
  }
})

test('a bundled worker that fails before ready reports its stderr in the startup error', async function (t) {
  t.timeout(60_000)

  process.env['QVAC_WORKER_PATH'] = await bundleWorker(t, 'stderr-before-ready-worker.mjs')

  const { getRPC, close } = await import('#rpc')

  t.teardown(async () => {
    try {
      await close()
    } catch {}
    delete process.env['QVAC_WORKER_PATH']
  })

  const error = (await getRPC().then(
    () => null,
    (thrown: unknown) => thrown
  )) as { name?: string; exitCode?: number | null; stderrTail?: string } | null
  t.is(error?.name, 'WORKER_STARTUP_FAILED')
  t.is(error?.exitCode, 3)
  t.ok(
    error?.stderrTail?.includes('QVAC_TEST_WORKER_STDERR_BEFORE_READY'),
    `stderrTail holds the worker's stderr: ${String(error?.stderrTail)}`
  )
})
