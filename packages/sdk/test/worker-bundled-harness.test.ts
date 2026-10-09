import test from 'brittle'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import stow from 'bare-stow'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

test('QVAC_WORKER_PATH naming a bundled worker folder starts it through its harness', async function (t) {
  t.timeout(60_000)

  const outDir = fs.mkdtempSync(path.join(__dirname, 'tmp-bundled-worker-'))
  const entry = path.join(__dirname, 'fixtures', 'init-failure-worker.mjs')
  for await (const artifact of stow(
    pathToFileURL(entry).href,
    'bare-sidecar',
    pathToFileURL(path.join(outDir, 'index.mjs')).href,
    { hosts: [`${process.platform}-${process.arch}`] }
  )) {
    t.ok(artifact.url)
  }

  process.env['QVAC_WORKER_PATH'] = outDir

  const { embed } = await import('@/client/api/embed')
  const { close } = await import('@/client/rpc/rpc-client')

  t.teardown(async () => {
    try {
      await close()
    } catch {}
    delete process.env['QVAC_WORKER_PATH']
    fs.rmSync(outDir, { recursive: true, force: true })
  })

  try {
    await embed({ modelId: 'irrelevant', text: 'hi' })
    t.fail('expected embed() to reject')
  } catch (error) {
    t.is((error as { name?: string }).name, 'SET_CONFIG_FAILED')
  }
})
