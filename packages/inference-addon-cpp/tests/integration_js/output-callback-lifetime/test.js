const test = require('brittle')
const addon = require('.')

// The OutputCallBackJs lifetime bug is timing- and allocator-sensitive. A
// regular run may pass, especially on linux-x64, so this test package should be
// run with AddressSanitizer to reliably catch the heap-use-after-free.

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

test('destroying addon with pending JS output callback does not crash', async (t) => {
  t.timeout(10000)
  t.plan(1)

  const iterations = 200
  let callbacks = 0

  for (let i = 0; i < iterations; i++) {
    const jsHandle = { iteration: i }
    const handle = addon.createInstance(jsHandle, () => {
      callbacks++
    })

    addon.runJob(handle, `job-${i}`)

    // Keep the JS thread busy while the worker queues output via uv_async_send.
    // Destroying before the next tick exercises OutputCallBackJs shutdown while
    // the async callback is still pending on the libuv loop.
    addon.blockEventLoop(2)
    addon.destroyInstance(handle)
    await nextTick()
  }

  t.pass(`completed ${iterations} create/run/destroy cycles (${callbacks} callbacks observed)`)
})

test('teardown flush runs its JS output callbacks on the JS thread', async (t) => {
  t.timeout(10000)
  t.plan(2)

  const events = []
  const handle = addon.createMultiInstance({ name: 'off-thread-flush' }, () => {
    events.push(addon.onJsThread())
  })

  addon.runJob(handle, 'job-a') // in-flight: blocks until the model is cancelled
  addon.runJob(handle, 'job-b') // queued behind job-a (concurrency 1)

  // The cancel task captures shared_ptr<AddonCpp>; destroying the instance in
  // the same tick makes that capture the last owner. Holding the JS thread in
  // blockEventLoop keeps the loop from draining, so the terminal events for
  // both jobs are still queued when the task thread releases the last owner
  // and ~AddonCpp flushes them.
  const cancelled = addon.cancelJob(handle)
  addon.destroyInstance(handle)
  addon.blockEventLoop(300)

  await cancelled
  await nextTick()

  t.ok(events.length >= 2, `terminal events delivered (${events.length})`)
  t.ok(events.every(Boolean), 'every output callback ran on the JS thread')
})

test('a throwing JS handler must not drop later events in the same drained batch', async (t) => {
  t.timeout(10000)
  t.plan(3)

  // A handler throw crossing js_call_function surfaces as a Bare
  // uncaughtException; swallow it like a long-lived app would so the process
  // survives and the delivery loop's behaviour is observable.
  let uncaught = 0
  const onUncaught = (err) => {
    if (err.message === 'boom') {
      uncaught++
      return
    }
    throw err
  }
  Bare.on('uncaughtException', onUncaught)
  t.teardown(() => Bare.off('uncaughtException', onUncaught))

  let calls = 0
  let delivered = 0
  const handle = addon.createInstance({ name: 'throwing-handler' }, () => {
    calls++
    if (calls === 1) throw new Error('boom')
    delivered++
  })

  addon.runJob(handle, 'job-a')
  addon.runJob(handle, 'job-b')

  // Hold the JS thread so both jobs finish and queue all their events before
  // the async callback fires: one deliverQueued drain then carries entries
  // for both jobs, and the first delivery throwing exercises the drop.
  addon.blockEventLoop(100)
  await nextTick()
  await nextTick()

  t.ok(uncaught >= 1, `throwing handler surfaced as uncaughtException (${uncaught})`)
  t.ok(calls >= 2, `later entries of the drained batch were dispatched (${calls} calls)`)
  t.ok(delivered >= 1, `events after the throwing one were delivered (${delivered})`)

  addon.destroyInstance(handle)
})

test('destroying addon from inside output callback does not crash', async (t) => {
  t.timeout(10000)
  t.plan(1)

  const churn = 50
  let handle = null
  let destroyed = false

  handle = addon.createInstance({ name: 'self-destroy' }, () => {
    if (destroyed) return
    destroyed = true
    addon.destroyInstance(handle)

    // Try to make use-after-free deterministic by reusing recently freed
    // callback storage before OutputCallBackJs::jsOutputCallback returns.
    for (let i = 0; i < churn; i++) {
      const extra = addon.createInstance({ churn: i }, () => {})
      addon.destroyInstance(extra)
    }
  })

  addon.runJob(handle, 'self-destroy')
  await nextTick()

  t.pass('destroyed addon while its output callback was active')
})
