import test from 'brittle'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SHIM = path.resolve(__dirname, '../dist/src/worker/unbundled-shim.js')
const HOST = path.resolve(__dirname, 'fixtures/abandoning-host.mjs')
const ENTRY = path.resolve(__dirname, 'fixtures/lingering-worker.mjs')

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return !isAlive(pid)
}

test('the worker exits when its host goes away without terminating it', async function (t) {
  t.timeout(30_000)

  const host = spawn('node', [HOST, SHIM, ENTRY], { stdio: ['ignore', 'pipe', 'inherit'] })
  let output = ''
  host.stdout.setEncoding('utf8')
  host.stdout.on('data', (chunk: string) => {
    output += chunk
  })
  const [code] = (await once(host, 'exit')) as [number | null]

  const pid = Number(/worker-pid (\d+)/.exec(output)?.[1])
  t.teardown(() => {
    if (pid > 0 && isAlive(pid)) process.kill(pid, 'SIGKILL')
  })

  t.is(code, 0, 'the host exited after the worker was ready')
  t.ok(pid > 0, `the worker reported its pid, got: ${output}`)
  t.ok(await waitForExit(pid, 10_000), 'the worker exited after its pipe ended')
})
