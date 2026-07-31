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
