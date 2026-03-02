'use strict'

const test = require('brittle')
const MockAddon = require('../MockAddon.js')
const MockONNXOcr = require('../MockONNXOcr.js')
const { wait } = require('../utils.js')

function createAddon (outputCb = () => {}, transitionCb = null) {
  return new MockAddon({}, outputCb, transitionCb)
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

// --- Initial state ---

test('MockAddon starts in loading state', async t => {
  const addon = createAddon()
  t.is(await addon.status(), 'loading', 'Initial state should be loading')
})

// --- State transitions ---

test('activate() transitions to listening', async t => {
  const addon = createAddon()
  await addon.activate()
  t.is(await addon.status(), 'listening', 'State should be listening after activate')
})

test('pause() transitions to paused', async t => {
  const addon = createAddon()
  await addon.activate()
  await addon.pause()
  t.is(await addon.status(), 'paused', 'State should be paused after pause')
})

test('stop() transitions to stopped', async t => {
  const addon = createAddon()
  await addon.activate()
  await addon.stop()
  t.is(await addon.status(), 'stopped', 'State should be stopped after stop')
})

test('destroy() transitions to idle', async t => {
  const addon = createAddon()
  await addon.activate()
  await addon.destroy()
  t.is(await addon.status(), 'idle', 'State should be idle after destroy')
})

test('cancel() transitions to stopped', async t => {
  const addon = createAddon()
  await addon.activate()
  await addon.cancel(1)
  t.is(await addon.status(), 'stopped', 'State should be stopped after cancel')
})

test('activate after pause resumes to listening', async t => {
  const addon = createAddon()
  await addon.activate()
  await addon.pause()
  t.is(await addon.status(), 'paused')
  await addon.activate()
  t.is(await addon.status(), 'listening', 'Should be listening after resume from pause')
})

test('activate after stop resumes to listening', async t => {
  const addon = createAddon()
  await addon.activate()
  await addon.stop()
  t.is(await addon.status(), 'stopped')
  await addon.activate()
  t.is(await addon.status(), 'listening', 'Should be listening after resume from stop')
})

// --- Transition callbacks ---

test('Transition callback is called on state changes', async t => {
  const transitions = []
  const transitionCb = (instance, newState) => {
    transitions.push(newState)
  }
  const addon = createAddon(() => {}, transitionCb)

  await addon.activate()
  await addon.pause()
  await addon.activate()
  await addon.stop()
  await addon.destroy()

  t.alike(transitions, ['listening', 'paused', 'listening', 'stopped', 'idle'],
    'Should record all state transitions in order')
})

// --- Appending data in wrong state ---

test('Append in loading state emits error', async t => {
  const events = []
  const outputCb = (addon, event, jobId, data, error) => {
    events.push({ event, data })
  }
  const addon = createAddon(outputCb)

  // Addon starts in 'loading' state, don't activate
  await addon.append({ type: 'image', input: Buffer.alloc(10) })
  await wait()

  t.is(events.length, 1, 'Should have received one event')
  t.is(events[0].event, 'Error', 'Event should be an Error')
  t.ok(events[0].data.error.includes('Invalid state'), 'Error should mention invalid state')
})

test('Append in stopped state emits error', async t => {
  const events = []
  const outputCb = (addon, event, jobId, data, error) => {
    events.push({ event, data })
  }
  const addon = createAddon(outputCb)

  await addon.activate()
  await addon.stop()
  await addon.append({ type: 'image', input: Buffer.alloc(10) })
  await wait()

  t.is(events.length, 1, 'Should have received one event')
  t.is(events[0].event, 'Error', 'Event should be an Error')
})

test('Append in paused state emits error', async t => {
  const events = []
  const outputCb = (addon, event, jobId, data, error) => {
    events.push({ event, data })
  }
  const addon = createAddon(outputCb)

  await addon.activate()
  await addon.pause()
  await addon.append({ type: 'image', input: Buffer.alloc(10) })
  await wait()

  t.is(events.length, 1, 'Should have received one event')
  t.is(events[0].event, 'Error', 'Event should be an Error')
})

// --- Unknown data type ---

test('Append with unknown type emits error', async t => {
  const events = []
  const outputCb = (addon, event, jobId, data, error) => {
    events.push({ event, data })
  }
  const addon = createAddon(outputCb)

  await addon.activate()
  await addon.append({ type: 'video', input: Buffer.alloc(10) })
  await wait()

  t.is(events.length, 1, 'Should have received one event')
  t.is(events[0].event, 'Error', 'Event should be an Error')
  t.ok(events[0].data.error.includes('Unknown type'), 'Error should mention unknown type')
})

// --- Job ID management ---

test('Job IDs increment after end-of-job marker', async t => {
  const events = []
  const outputCb = (addon, event, jobId, data, error) => {
    events.push({ event, jobId })
  }
  const addon = createAddon(outputCb)

  await addon.activate()

  const job1 = await addon.append({ type: 'image', input: Buffer.alloc(10) })
  await addon.append({ type: 'end of job' })
  await wait()

  const job2 = await addon.append({ type: 'image', input: Buffer.alloc(10) })
  await addon.append({ type: 'end of job' })
  await wait()

  t.is(job1, 1, 'First job should have ID 1')
  t.is(job2, 2, 'Second job should have ID 2')
})

// --- Progress ---

test('progress() returns processed and total', async t => {
  const addon = createAddon()
  const progress = await addon.progress()

  t.ok(typeof progress.processed === 'number', 'processed should be a number')
  t.ok(typeof progress.total === 'number', 'total should be a number')
  t.ok(progress.total > 0, 'total should be greater than 0')
})

// --- Full lifecycle via MockONNXOcr ---

test('MockONNXOcr full lifecycle: load, run, stop', async t => {
  const model = createModel()
  await model.load()

  t.is(await model.status(), 'listening', 'Should be listening after load')

  await model.pause()
  t.is(await model.status(), 'paused', 'Should be paused')

  await model.unpause()
  t.is(await model.status(), 'listening', 'Should be listening after unpause')

  await model.stop()
  t.is(await model.status(), 'stopped', 'Should be stopped')
})

test('MockONNXOcr can run multiple jobs sequentially', async t => {
  const model = createModel()
  await model.load()

  const response1 = await model.run({ path: 'test/images/basic_test.bmp' })
  let output1Received = false
  response1.onUpdate(() => { output1Received = true })
  await response1.await()
  t.ok(output1Received, 'First job should produce output')

  await wait(50)

  const response2 = await model.run({ path: 'test/images/basic_test.bmp' })
  let output2Received = false
  response2.onUpdate(() => { output2Received = true })
  await response2.await()
  t.ok(output2Received, 'Second job should also produce output')
})
