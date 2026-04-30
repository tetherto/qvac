'use strict'

const test = require('brittle')
const QvacResponse = require('../../src/QvacResponse')

const dummyCancelHandler = async () => {}
const dummyPauseHandler = async () => {}
const dummyContinueHandler = async () => {}

// ------------------------------
// Test hooks and iterator (onUpdate, onFinish, onError, getLatest, iterate)
// ------------------------------

test('onUpdate should trigger callback on updateOutput', async t => {
  const response = new QvacResponse({
    cancelHandler: dummyCancelHandler,
    pauseHandler: dummyPauseHandler,
    continueHandler: dummyContinueHandler
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
    cancelHandler: dummyCancelHandler,
    pauseHandler: dummyPauseHandler,
    continueHandler: dummyContinueHandler
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
    cancelHandler: dummyCancelHandler,
    pauseHandler: dummyPauseHandler,
    continueHandler: dummyContinueHandler
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
    cancelHandler: dummyCancelHandler,
    pauseHandler: dummyPauseHandler,
    continueHandler: dummyContinueHandler
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
    cancelHandler: dummyCancelHandler,
    pauseHandler: dummyPauseHandler,
    continueHandler: dummyContinueHandler
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
      cancelHandler: dummyCancelHandler,
      pauseHandler: dummyPauseHandler,
      continueHandler: dummyContinueHandler
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
    cancelHandler: dummyCancelHandler,
    pauseHandler: dummyPauseHandler,
    continueHandler: dummyContinueHandler
  })
  const chainedInstance = response
    .onUpdate(() => {})
    .onError(() => {})
    .onCancel(() => {})
    .onPause(() => {})
    .onContinue(() => {})
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
    cancelHandler,
    pauseHandler: dummyPauseHandler,
    continueHandler: dummyContinueHandler
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
    cancelHandler: async () => { cancelHandlerCalled = true },
    pauseHandler: dummyPauseHandler,
    continueHandler: dummyContinueHandler
  })
  response.ended()

  await response.cancel()
  t.absent(cancelHandlerCalled, 'cancelHandler should not be called when already finished')
})

// ------------------------------
// Pause / Continue Tests
// ------------------------------

test('pause triggers pauseHandler and changes state to PAUSED', async t => {
  let pauseHandlerCalled = false
  const pauseHandler = async () => {
    pauseHandlerCalled = true
  }
  const response = new QvacResponse({
    cancelHandler: dummyCancelHandler,
    pauseHandler,
    continueHandler: dummyContinueHandler
  })

  let pauseEventCalled = false
  response.onPause(() => {
    pauseEventCalled = true
  })

  await response.pause()
  t.ok(pauseHandlerCalled, 'pauseHandler was called')
  t.ok(pauseEventCalled, 'pause event was emitted')
  t.is(response.getStatus(), 'paused', 'response state is PAUSED')
})

test('continue triggers continueHandler and changes state to RUNNING', async t => {
  let continueHandlerCalled = false
  const continueHandler = async () => {
    continueHandlerCalled = true
  }
  const response = new QvacResponse({
    cancelHandler: dummyCancelHandler,
    pauseHandler: dummyPauseHandler,
    continueHandler
  })

  await response.pause()

  let continueEventCalled = false
  response.onContinue(() => {
    continueEventCalled = true
  })
  await response.continue()
  t.ok(continueHandlerCalled, 'continueHandler was called')
  t.ok(continueEventCalled, 'continue event was emitted')
  t.is(response.getStatus(), 'running', 'response state is RUNNING')
})

test('pause should throw error if not in RUNNING state', async t => {
  const response = new QvacResponse({
    cancelHandler: dummyCancelHandler,
    pauseHandler: dummyPauseHandler,
    continueHandler: dummyContinueHandler
  })

  response._status = 'ended'
  try {
    await response.pause()
    t.fail('pause should throw error when state is not RUNNING')
  } catch (err) {
    t.is(
      err.message,
      'ERR_NOT_RUNNING',
      'pause threw the correct error message'
    )
  }
})

test('continue should throw error if not in PAUSED state', async t => {
  const response = new QvacResponse({
    cancelHandler: dummyCancelHandler,
    pauseHandler: dummyPauseHandler,
    continueHandler: dummyContinueHandler
  })

  try {
    await response.continue()
    t.fail('continue should throw error when state is not PAUSED')
  } catch (err) {
    t.is(
      err.message,
      'ERR_NOT_PAUSED',
      'continue threw the correct error message'
    )
  }
})

// ------------------------------
// Chaining onFinish and await Test
// ------------------------------

test('onFinish chaining and await returns final outputs', async t => {
  const response = new QvacResponse({
    cancelHandler: dummyCancelHandler,
    pauseHandler: dummyPauseHandler,
    continueHandler: dummyContinueHandler
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
