const test = require('brittle')
const Thread = require('bare-thread')
const addon = require('.')

// Real-runtime coverage for the env-scoped JsAsyncTask teardown guard
// (QVAC-18397): the C++ unit suite mocks uv and dispatches async send/close
// synchronously on the calling thread, so it cannot exercise the actual
// loop-thread handshake. Here a real bare-thread env is terminated while a
// JsAsyncTask worker is still running: the deferred env teardown must keep
// the dying env's loop alive until the worker finishes, completion must skip
// every JS operation on the dead env, and the teardown must then complete —
// without crashing the process or blocking the join forever.

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(condition, what, timeout = 10000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start >= timeout) {
      throw new Error(`timed out waiting for ${what}`)
    }
    await delay(5)
  }
}

test('env terminated while a JsAsyncTask worker is blocked defers teardown until the worker finishes', async (t) => {
  t.timeout(60000)

  addon.resetGate()
  const thread = new Thread('./worker-gated-task.js')

  // Terminate only once the worker is provably inside its work, so the env
  // teardown genuinely races a running JsAsyncTask rather than a queued one.
  await waitFor(() => addon.taskStarted() === 1, 'the gated worker to start')
  thread.terminate()

  // The env is now tearing down but the worker is still parked on the gate:
  // teardown must wait for it (deferred), not kill it or crash the process.
  await delay(100)
  t.is(
    addon.taskFinished(),
    0,
    'worker still blocked after terminate — teardown is deferred, not forced'
  )

  // Releasing the gate lets the worker finish; the deferred teardown must now
  // run to completion, otherwise this join blocks forever.
  addon.releaseGate()
  thread.join()

  t.is(addon.taskFinished(), 1, 'worker ran to completion under the dying env')
})

test('runtime survives a terminate sweep across the worker completion window', async (t) => {
  t.timeout(60000)

  const ROUNDS = 40
  for (let i = 0; i < ROUNDS; i++) {
    const thread = new Thread('./worker-timed-tasks.js')
    // Vary when terminate() lands relative to the workers' completions so the
    // rounds sweep the send-before/during/after-teardown race windows.
    await delay(2 + (i % 8))
    thread.terminate()
    thread.join()
  }

  t.pass(`main runtime survived ${ROUNDS} terminations with workers in flight`)
})
