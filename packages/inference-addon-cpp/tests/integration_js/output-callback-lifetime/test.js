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
