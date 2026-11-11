import test from 'brittle'
import Sidecar from 'bare-sidecar'
import stow from 'bare-stow'
import pearRuntimeTarget from 'bare-stow-target-pear-runtime'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { waitForBareChildren, isAlive } from './fixtures/bare-children'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SILENT_WORKER = path.resolve(__dirname, 'fixtures/silent-worker.mjs')
const PEAR_RUNTIME = path.resolve(__dirname, '../dist/src/client/rpc/pear-runtime.js')
const START_TIMEOUT_MS = 20_000
const CLOSE_LIMIT_MS = 5_000

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-close-before-ready-'))
const configPath = path.join(configDir, 'qvac.config.json')
fs.writeFileSync(configPath, JSON.stringify({ rpcInitTimeoutMs: START_TIMEOUT_MS }))
process.env['QVAC_CONFIG_PATH'] = configPath

const { getRPC, close } = await import('#rpc')

async function bundleSilentWorker(
  t: { teardown: (fn: () => void) => void },
  target: Parameters<typeof stow>[1]
): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(__dirname, 'tmp-close-before-ready-'))
  t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const outDir = path.join(tmpDir, 'worker')
  for await (const artifact of stow(
    pathToFileURL(SILENT_WORKER).href,
    target,
    pathToFileURL(outDir).href,
    { hosts: [`${process.platform}-${process.arch}`] }
  )) {
    void artifact
  }
  return outDir
}

async function closeDuringStart(t: Parameters<Parameters<typeof test>[1]>[0], workerPath: string) {
  process.env['QVAC_WORKER_PATH'] = workerPath
  t.teardown(async () => {
    try {
      await close()
    } catch {}
    delete process.env['QVAC_WORKER_PATH']
  })

  const starting = getRPC()
  starting.catch(() => {})

  const pids = await waitForBareChildren(process.pid)
  t.ok(pids.length > 0, 'expected the silent worker to be running')

  const closeStartedAt = Date.now()
  await close()
  const closeMs = Date.now() - closeStartedAt
  t.ok(closeMs < CLOSE_LIMIT_MS, `close() returns before the start timeout (took ${closeMs}ms)`)

  const error = (await starting.then(
    () => null,
    (thrown: unknown) => thrown
  )) as { name?: string } | null
  t.is(error?.name, 'WORKER_SHUTDOWN', 'the pending start rejects with WORKER_SHUTDOWN')

  const alive = pids.filter((pid) => isAlive(pid))
  t.alike(alive, [], 'no worker process is left after close()')
}

test('close() during an unbundled start stops a worker that never signals ready', async function (t) {
  t.timeout(START_TIMEOUT_MS + 20_000)
  await closeDuringStart(t, SILENT_WORKER)
})

test('close() during a bundled start stops a worker that never signals ready', async function (t) {
  t.timeout(START_TIMEOUT_MS + 60_000)
  await closeDuringStart(t, await bundleSilentWorker(t, 'bare-sidecar'))
})

// Registering a Pear runtime applies to every later start, so this test runs last.
test('close() during a Pear start stops a worker that never signals ready', async function (t) {
  t.timeout(START_TIMEOUT_MS + 60_000)
  t.teardown(() => fs.rmSync(configDir, { recursive: true, force: true }))

  const workerDir = await bundleSilentWorker(t, pearRuntimeTarget)
  const { usePearRuntime } = (await import(
    pathToFileURL(PEAR_RUNTIME).href
  )) as typeof import('@/client/rpc/pear-runtime')
  usePearRuntime({
    run: (bundle: string, args?: string[], opts?: object) => new Sidecar(bundle, args, opts)
  })

  await closeDuringStart(t, workerDir)
})
