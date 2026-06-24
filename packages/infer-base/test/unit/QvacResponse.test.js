'use strict'

const test = require('brittle')
const QvacResponse = require('../../src/QvacResponse')
const { makeAbortable } = require('../mocks/abortable')

const dummyCancelHandler = async () => {}

// ------------------------------
// Test hooks and iterator (onUpdate, onFinish, onError, getLatest, iterate)
// ------------------------------

test('onUpdate should trigger callback on updateOutput', async t => {
  const response = new QvacResponse({
    cancelHandler: dummyCancelHandler
  })
  let received = null
  response.onUpdate(data => {
    received = data
  })

  const testData = { msg: 'hello' }
  response.updateOutput(testData)

  await new Promise(resolve => setTimeout(resolve, 50))
  t.alike(received, testData, 'onUpdate callback received the correct output')
})

test('onFinish resolves with final outputs on ended via await()', async t => {
  const response = new QvacResponse({
    cancelHandler: dummyCancelHandler
  })
  let finishCallbackOutput = null

  response.onFinish(finalOutputs => {
    finishCallbackOutput = finalOutputs
  })

  response.updateOutput('first')
  response.updateOutput('second')
  response.ended()

  const result = await response.await()
  t.alike(
    result,
    ['first', 'second'],
    'await() promise resolves with the correct outputs'
  )
  t.alike(
    finishCallbackOutput,
    ['first', 'second'],
    'onFinish callback was invoked with the correct outputs'
  )
})

test('onFinish and await resolve with custom terminal result', async t => {
  const response = new QvacResponse({
    cancelHandler: dummyCancelHandler
  })

  const terminalResult = {
    op: 'finetune',
    status: 'DONE',
    stats: { train_loss: 0.42 }
  }
  let finishCallbackResult = null

  response.onFinish(result => {
    finishCallbackResult = result
  })

  response.updateOutput('intermediate')
  response.ended(terminalResult)

  const result = await response.await()
  t.is(result, terminalResult, 'await() resolves with custom terminal result')
  t.is(
    finishCallbackResult,
    terminalResult,
    'onFinish callback receives custom terminal result'
  )
})

test('failed should trigger error and reject await()', async t => {
  const response = new QvacResponse({
    cancelHandler: dummyCancelHandler
  })
  let errorCallbackCalled = false

  response.onError(err => {
    errorCallbackCalled = true
    t.ok(err instanceof Error, 'onError received an Error instance')
  })

  const testError = new Error('Test error')
  response.failed(testError)

  try {
    await response.await()
    t.fail('await() should have rejected')
  } catch (err) {
    t.alike(err, testError, 'await() rejected with the correct error')
  }
  t.ok(errorCallbackCalled, 'onError callback was called')
})

test('getLatest returns the most recent output', t => {
  const response = new QvacResponse({
    cancelHandler: dummyCancelHandler
  })
  t.is(
    response.getLatest(),
    null,
    'getLatest returns null when there is no output'
  )

  response.updateOutput('first')
  response.updateOutput('second')
  t.is(
    response.getLatest(),
    'second',
    'getLatest returns the most recent output'
  )
  t.end()
})

test('iterate yields outputs until ended', async t => {
  const response = new QvacResponse(
    {
      cancelHandler: dummyCancelHandler
    },
    10
  )

  setTimeout(() => response.updateOutput('a'), 20)
  setTimeout(() => response.updateOutput('b'), 40)
  setTimeout(() => response.ended(), 60)

  const collected = []
  for await (const data of response.iterate()) {
    collected.push(data)
  }
  t.alike(collected, ['a', 'b'], 'iterate yields all outputs correctly')
})

test('chaining should return the same instance', t => {
  const response = new QvacResponse({
    cancelHandler: dummyCancelHandler
  })
  const chainedInstance = response
    .onUpdate(() => {})
    .onError(() => {})
    .onCancel(() => {})
    .onFinish(() => {})
  t.is(
    chainedInstance,
    response,
    'All chaining methods return the same instance'
  )
  t.end()
})

// ------------------------------
// Cancel Tests
// ------------------------------

test('cancel calls cancelHandler and emits cancel', async t => {
  let cancelHandlerCalled = false
  const cancelHandler = async () => {
    cancelHandlerCalled = true
  }
  const response = new QvacResponse({
    cancelHandler
  })

  let cancelEventCalled = false
  response.onCancel(() => {
    cancelEventCalled = true
  })

  await response.cancel()
  t.ok(cancelHandlerCalled, 'cancelHandler was called')
  t.ok(cancelEventCalled, 'cancel event was emitted')
})

test('cancel is a no-op if response is already finished', async t => {
  let cancelHandlerCalled = false
  const response = new QvacResponse({
    cancelHandler: async () => { cancelHandlerCalled = true }
  })
  response.ended()

  await response.cancel()
  t.absent(cancelHandlerCalled, 'cancelHandler should not be called when already finished')
})

// ------------------------------
// Chaining onFinish and await Test
// ------------------------------

// ------------------------------
// Idempotent terminal settlement
// ------------------------------

test('failed is idempotent — second failed() does not re-emit or re-reject', async t => {
  const response = new QvacResponse({ cancelHandler: dummyCancelHandler })
  let errorEmits = 0
  response.onError(() => { errorEmits++ })

  response.failed(new Error('first'))
  response.failed(new Error('second'))

  t.is(errorEmits, 1, 'error event emits exactly once')

  try {
    await response.await()
    t.fail('await should reject')
  } catch (err) {
    t.is(err.message, 'first', 'finish promise carries the first error')
  }
})

test('ended after failed is a no-op', async t => {
  const response = new QvacResponse({ cancelHandler: dummyCancelHandler })
  response.failed(new Error('boom'))
  response.ended('payload')

  try {
    await response.await()
    t.fail('await should reject')
  } catch (err) {
    t.is(err.message, 'boom', 'finish promise still carries the original error')
  }
})

test('failed after ended is a no-op', async t => {
  const response = new QvacResponse({ cancelHandler: dummyCancelHandler })
  response.updateOutput('value')
  response.ended()
  response.failed(new Error('late'))

  const result = await response.await()
  t.alike(result, ['value'], 'finish promise still resolves with the original payload')
})

// ------------------------------
// Constructor signal wiring
// ------------------------------

test('constructor signal — abort after construction fails the response with the abort reason', async t => {
  const controller = makeAbortable()
  class TestCancel extends Error {
    constructor () { super('test-cancel'); this.name = 'TestCancel' }
  }
  const response = new QvacResponse({
    cancelHandler: dummyCancelHandler,
    signal: controller.signal
  })

  const reason = new TestCancel()
  controller.abort(reason)

  try {
    await response.await()
    t.fail('await should reject')
  } catch (err) {
    t.is(err, reason, 'await rejects with the abort reason unchanged')
  }
})

test('constructor signal — already-aborted signal fails the response with the abort reason', async t => {
  const controller = makeAbortable()
  controller.abort(new Error('precancel'))
  const response = new QvacResponse({
    cancelHandler: dummyCancelHandler,
    signal: controller.signal
  })

  try {
    await response.await()
    t.fail('await should reject')
  } catch (err) {
    t.is(err.message, 'precancel', 'await rejects with the abort reason')
  }
})

test('constructor signal — already-aborted signal fires onError listeners attached after construction', async t => {
  const controller = makeAbortable()
  controller.abort(new Error('precancel'))
  const response = new QvacResponse({
    cancelHandler: dummyCancelHandler,
    signal: controller.signal
  })

  // Settlement is deferred to a microtask so a listener attached here still fires.
  let received = null
  response.onError(err => { received = err })

  await response.await().catch(() => {})

  t.ok(received instanceof Error, 'error listener fired')
  t.is(received.message, 'precancel', 'error listener received the abort reason')
})

test('constructor signal — synchronous ended() after already-aborted construction does not win the race', async t => {
  const controller = makeAbortable()
  controller.abort(new Error('precancel'))
  const response = new QvacResponse({
    cancelHandler: dummyCancelHandler,
    signal: controller.signal
  })

  // Synchronous terminal callback fired before the deferred notification runs
  // must not settle the response with success — the abort reserved the state.
  response.ended('success')

  try {
    await response.await()
    t.fail('await should reject')
  } catch (err) {
    t.is(err.message, 'precancel', 'await rejects with the abort reason despite synchronous ended()')
  }
})

test('constructor signal — non-Error abort reason is wrapped in a default Error', async t => {
  const controller = makeAbortable()
  const response = new QvacResponse({
    cancelHandler: dummyCancelHandler,
    signal: controller.signal
  })

  controller.abort('plain string reason')

  try {
    await response.await()
    t.fail('await should reject')
  } catch (err) {
    t.ok(err instanceof Error, 'rejection is an Error')
    t.is(err.message, 'Aborted: plain string reason', 'message embeds the stringified reason')
  }
})

test('constructor signal — abort with no reason produces a default Error', async t => {
  const controller = makeAbortable()
  const response = new QvacResponse({
    cancelHandler: dummyCancelHandler,
    signal: controller.signal
  })

  controller.abort()

  try {
    await response.await()
    t.fail('await should reject')
  } catch (err) {
    t.ok(err instanceof Error, 'rejection is an Error')
    t.is(err.message, 'Aborted', 'default message when reason is undefined')
  }
})

test('constructor signal — listener detaches on natural terminal', async t => {
  const controller = makeAbortable()
  const response = new QvacResponse({
    cancelHandler: dummyCancelHandler,
    signal: controller.signal
  })

  response.ended('done')

  // Late abort must not re-emit / re-reject — listener should be detached.
  controller.abort(new Error('late'))
  const result = await response.await()
  t.is(result, 'done', 'await resolves with the original result')
})

// ------------------------------
// iterate behavior under external settle
// ------------------------------

test('iterate stops promptly when the response is externally failed', async t => {
  const controller = makeAbortable()
  const response = new QvacResponse(
    {
      cancelHandler: dummyCancelHandler,
      signal: controller.signal
    },
    1000 // long poll interval — if iterate fell back to polling we would notice
  )

  const collected = []
  const iterStart = Date.now()
  setTimeout(() => controller.abort(new Error('aborted')), 20)

  try {
    for await (const data of response.iterate()) {
      collected.push(data)
    }
    t.fail('iterate should throw on external failure')
  } catch (err) {
    t.is(err.message, 'aborted', 'iterate rethrows the failure error')
    const elapsed = Date.now() - iterStart
    t.ok(elapsed < 500, `iterate woke up promptly (${elapsed}ms)`)
  }
  t.alike(collected, [], 'no outputs collected before abort')
})

test('iterate wakes promptly on output events without polling', async t => {
  const response = new QvacResponse(
    { cancelHandler: dummyCancelHandler },
    1000 // long poll interval — wake must come from the output event
  )

  setTimeout(() => response.updateOutput('a'), 10)
  setTimeout(() => response.updateOutput('b'), 25)
  setTimeout(() => response.ended(), 40)

  const collected = []
  const iterStart = Date.now()
  for await (const data of response.iterate()) {
    collected.push(data)
  }
  const elapsed = Date.now() - iterStart
  t.alike(collected, ['a', 'b'], 'all outputs collected')
  t.ok(elapsed < 500, `iterate woke up on events not pollInterval (${elapsed}ms)`)
})

test('onFinish chaining and await returns final outputs', async t => {
  const response = new QvacResponse({
    cancelHandler: dummyCancelHandler
  })

  response
    .onUpdate(output => {
      t.alike(
        output,
        'chained',
        'onUpdate callback receives the correct output'
      )
    })
    .onFinish(outputs => {
      t.alike(
        outputs,
        ['chained'],
        'onFinish callback receives correct outputs'
      )
    })
  response.updateOutput('chained')
  response.ended()

  const finalOutputs = await response.await()
  t.alike(
    finalOutputs,
    ['chained'],
    'await() returns the correct final outputs'
  )
})
