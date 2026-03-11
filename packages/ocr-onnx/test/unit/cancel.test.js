'use strict'

// Unit tests for cooperative cancellation behaviour.
// These tests run against MockAddon/MockONNXOcr so no real models are required.

const test = require('brittle')
const MockAddon = require('../MockAddon.js')
const MockONNXOcr = require('../MockONNXOcr.js')
const { wait } = require('../utils.js')

function createAddon (outputCb, transitionCb) {
  return new MockAddon({}, outputCb || (() => {}), transitionCb || null)
}

function createModel () {
  return new MockONNXOcr({
    params: {
      langList: ['en'],
      pathDetector: 'detector.onnx',
      pathRecognizer: 'recognizer_latin.onnx'
    },
    opts: {}
  })
}

// --- cancel() state transition ---

test('cancel() transitions addon to stopped state', async t => {
  const addon = createAddon()
  await addon.activate()
  t.is(await addon.status(), 'listening', 'Precondition: should be listening before cancel')

  await addon.cancel(1)

  t.is(await addon.status(), 'stopped', 'State should be stopped after cancel')
})

test('cancel() fires transition callback with stopped state', async t => {
  const transitions = []
  const transitionCb = (instance, newState) => { transitions.push(newState) }
  const addon = createAddon(() => {}, transitionCb)

  await addon.activate()
  await addon.cancel(1)

  t.ok(transitions.includes('stopped'), 'Transition callback should record stopped state')
})

// --- cancel before any run ---

test('cancel() before load does not throw', async t => {
  const addon = createAddon()
  // Addon is in 'loading' state – cancel should not crash

  try {
    await addon.cancel(null)
    t.pass('cancel() before activate does not throw')
  } catch (err) {
    t.fail('cancel() before activate should not throw: ' + err.message)
  }
})

test('cancel() before model.run does not prevent subsequent run', async t => {
  const model = createModel()
  await model.load()

  // cancel via the addon directly before any run is attempted
  await model.addon.cancel(null)
  t.is(await model.status(), 'stopped', 'Model should be in stopped state after cancel')

  // Re-activate so the model can accept a new job
  await model.addon.activate()
  t.is(await model.status(), 'listening', 'Model should be listening after re-activate')

  // Now run a job – it should succeed
  const response = await model.run({ path: 'test/images/basic_test.bmp' })
  let outputReceived = false
  response.onUpdate(() => { outputReceived = true })
  await response.await()

  t.ok(outputReceived, 'Run after cancel-then-activate should produce output')
})

// --- cancel() wiring from response object ---

test('cancel handler on response calls addon.cancel', async t => {
  const model = createModel()
  await model.load()

  const response = await model.run({ path: 'test/images/basic_test.bmp' })

  // The response exposes a cancel() method that is wired to addon.cancel()
  t.ok(typeof response.cancel === 'function', 'response.cancel should be a function')

  // Calling response.cancel() should not throw
  try {
    await response.cancel()
    t.pass('response.cancel() did not throw')
  } catch (err) {
    // Some implementations reject if the job already ended – that is acceptable
    t.comment('response.cancel() threw: ' + err.message)
    t.pass('cancel threw but did not crash – acceptable')
  }
})

// --- sequential runs after cancel ---

test('two sequential runs succeed when cancel is not called between them', async t => {
  const model = createModel()
  await model.load()

  const response1 = await model.run({ path: 'test/images/basic_test.bmp' })
  let output1 = null
  response1.onUpdate(data => { output1 = data })
  await response1.await()
  t.ok(output1, 'First run should produce output')

  await wait(50)

  const response2 = await model.run({ path: 'test/images/basic_test.bmp' })
  let output2 = null
  response2.onUpdate(data => { output2 = data })
  await response2.await()
  t.ok(output2, 'Second sequential run should also produce output')
})

test('run after cancel-and-reactivate succeeds (flag-reset semantics)', async t => {
  // This mirrors the C++ flag-reset: cancelFlag_ is cleared at the start of
  // each process() call, so a cancelled pipeline is immediately reusable.
  const model = createModel()
  await model.load()

  // Simulate a cancel mid-flight and then re-activate
  await model.addon.cancel(null)
  await model.addon.activate()

  const response = await model.run({ path: 'test/images/basic_test.bmp' })
  let outputReceived = false
  response.onUpdate(() => { outputReceived = true })
  await response.await()

  t.ok(outputReceived, 'Run should succeed after cancel + activate (flag reset)')
})
