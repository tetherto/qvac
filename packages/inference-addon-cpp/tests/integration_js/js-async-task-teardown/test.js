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

  try {
    await addon.startFailingTask()
    t.fail('expected the task to reject')
  } catch (err) {
    t.is(err.message, 'boom from JsAsyncTask worker')
    t.is(err.code, 'INTERNAL_ERROR')
  }
})

test('JsAsyncTask resolves with the marshalled result', async (t) => {
  t.timeout(15000)

  t.is(await addon.startDoublingTask(21), 42)
})

test('JsAsyncTask rejects with the StatusError code of the worker', async (t) => {
  t.timeout(15000)

  try {
    await addon.startFailingValueTask()
    t.fail('expected the task to reject')
  } catch (err) {
    t.is(err.message, 'bad input for JsAsyncTask worker')
    t.is(err.code, '[ General :: InvalidArgument ]')
  }
})

// The completion runs with an empty JavaScript stack, so libjs hands an
// exception thrown there to the uncaught handler.
test('JsAsyncTask rejects when a JavaScript call fails while marshalling', async (t) => {
  t.timeout(15000)

  const thrown = new Error('thrown while marshalling')
  const uncaught = []
  const onUncaught = (err) => uncaught.push(err)
  Bare.on('uncaughtException', onUncaught)
  t.teardown(() => Bare.off('uncaughtException', onUncaught))

  try {
    await addon.startThrowingMarshalTask(() => {
      throw thrown
    })
    t.fail('expected the task to reject')
  } catch (err) {
    t.is(err.code, '[ General :: JSLibraryError ]')
    t.is(err.message, 'a JavaScript call failed and its exception was reported as uncaught')
  }
  t.is(uncaught.length, 1, 'the thrown error is reported once')
  t.is(uncaught[0], thrown)
})
