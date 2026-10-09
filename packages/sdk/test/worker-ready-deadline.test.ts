import test from 'brittle'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { waitForBareChildren, isAlive } from './fixtures/bare-children'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HARNESS = path.resolve(__dirname, '../dist/src/client/rpc/unbundled-harness.js')

test('an unbundled start that times out kills a worker that never signals ready', async function (t) {
  t.timeout(20_000)

  const { start } = (await import(
    pathToFileURL(HARNESS).href
  )) as typeof import('@/client/rpc/unbundled-harness')
  const starting = start(path.resolve(__dirname, 'fixtures/silent-worker.mjs'), {
    timeout: 2_000
  })

  const pids = await waitForBareChildren(process.pid)
  t.ok(pids.length > 0, 'expected the silent worker to be running')

  try {
    await starting
    t.fail('expected start() to reject')
  } catch (error) {
    t.ok(error instanceof Error && error.message.includes('timed out before ready'))
  }

  const until = Date.now() + 10_000
  let alive = pids
  while (Date.now() < until) {
    alive = pids.filter((pid) => isAlive(pid))
    if (alive.length === 0) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  t.is(alive.length, 0, `worker still alive after the timeout: ${alive.join(',')}`)
})
