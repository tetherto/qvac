const test = require('brittle')
const Thread = require('bare-thread')

// Regression test for QVAC-21544: a worker runtime is torn down (bare_teardown)
// while the C++->JS logger still has work in flight from background threads and
// releaseLogger() was never called. Tearing the runtime down is a supported
// lifecycle operation, so the process must survive it. Before the env-teardown
// hook in JsLogger, the teardown's final uv_run dispatched asyncCallback against
// the disposing context (js_get_global -> v8::Context::Global()) and aborted.

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('logger survives forced worker runtime teardown (QVAC-21544)', async (t) => {
  t.timeout(60000)

  const ROUNDS = 40
  for (let i = 0; i < ROUNDS; i++) {
    const thread = new Thread('./worker-entry-teardown.js')
    // Vary the delay so terminate() lands at different points relative to the
    // background logging, covering the race window across rounds.
    await delay(3 + (i % 7))
    thread.terminate()
    await delay(3)
  }

  t.pass(`main runtime survived ${ROUNDS} forced worker teardowns`)
})
