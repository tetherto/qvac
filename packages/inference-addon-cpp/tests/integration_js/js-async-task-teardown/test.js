const test = require('brittle')
const addon = require('.')

// Live-env sanity for JsAsyncTask on a real Bare loop: the work runs on a
// background thread and the promise settles back on the JS thread via a real
// uv_async round-trip. The env-teardown races live in teardown.test.js.

test('JsAsyncTask resolves after the worker finishes', async (t) => {
  t.timeout(15000)

  await addon.startTimedTask(10)
  t.pass('promise resolved on the JS thread')
})

test('JsAsyncTask rejects with the worker error', async (t) => {
  t.timeout(15000)

  await t.exception(
    addon.startFailingTask(),
    /boom from JsAsyncTask worker/,
    'worker exception surfaces as the rejection reason'
  )
})

// The captures are what callers actually wait on: cancelJob pins the addon —
// and the model it owns — inside the work closure, so a caller that awaits
// cancel() before unloading must find it already released. Releasing it in the
// close phase instead resolves the promise while the model is still pinned,
// which let unload() -> load() hold two models at once (PR #3548).
test('JsAsyncTask releases its captures before resolving', async (t) => {
  t.timeout(15000)

  const settled = addon.startCaptureReleaseTask()
  t.is(addon.captureReleased(), 0, 'the capture is still held while the task runs')

  await settled
  t.is(addon.captureReleased(), 1, 'awaiting the promise must mean the capture is gone')
})
