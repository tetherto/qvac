const test = require('brittle')
const addon = require('.')

// The OutputCallBackJs lifetime bug is timing- and allocator-sensitive. A
// regular run may pass, especially on linux-x64, so this test package should be
// run with AddressSanitizer to reliably catch the heap-use-after-free.

function nextTick () {
  return new Promise(resolve => setTimeout(resolve, 0))
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
