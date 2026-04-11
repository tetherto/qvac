'use strict'

const test = require('brittle')
const createJobHandler = require('../../src/utils/createJobHandler')

test('createJobHandler - start returns a QvacResponse', t => {
  const job = createJobHandler({ cancel: () => {} })
  const response = job.start()

  t.ok(response, 'response should exist')
  t.is(typeof response.onUpdate, 'function', 'should have onUpdate')
  t.is(typeof response.onFinish, 'function', 'should have onFinish')
  t.is(typeof response.onError, 'function', 'should have onError')
  t.is(typeof response.cancel, 'function', 'should have cancel')
  t.is(typeof response.await, 'function', 'should have await')
})

test('createJobHandler - start sets active response', t => {
  const job = createJobHandler({ cancel: () => {} })

  t.is(job.active, null, 'active should be null before start')
  const response = job.start()
  t.is(job.active, response, 'active should be the started response')
})

test('createJobHandler - output routes data to active response', t => {
  const job = createJobHandler({ cancel: () => {} })
  const response = job.start()
  const received = []

  response.onUpdate(data => received.push(data))

  job.output('hello')
  job.output('world')

  t.alike(received, ['hello', 'world'], 'outputs should be routed to response')
  t.alike(response.output, ['hello', 'world'], 'response.output should accumulate')
})

test('createJobHandler - output is no-op when no active response', t => {
  const job = createJobHandler({ cancel: () => {} })
  job.output('orphan data')
  t.pass('should not throw')
})

test('createJobHandler - end calls ended on response and clears active', async t => {
  const job = createJobHandler({ cancel: () => {} })
  const response = job.start()

  job.output('data')
  job.end()

  const result = await response.await()
  t.alike(result, ['data'], 'await should resolve with output array')
  t.is(job.active, null, 'active should be null after end')
})

test('createJobHandler - end forwards stats before ending', async t => {
  const job = createJobHandler({ cancel: () => {} })
  const response = job.start()
  let receivedStats = null

  response.on('stats', s => { receivedStats = s })

  const stats = { TPS: 42, totalTime: 100 }
  job.end(stats)

  t.is(receivedStats, stats, 'stats should be forwarded via updateStats')
  t.alike(response.stats, stats, 'response.stats should be set')
})

test('createJobHandler - end with null stats does not call updateStats', async t => {
  const job = createJobHandler({ cancel: () => {} })
  const response = job.start()
  let statsCalled = false

  response.on('stats', () => { statsCalled = true })

  job.end(null)

  t.not(statsCalled, 'updateStats should not be called with null stats')
})

test('createJobHandler - end with result passes it to ended()', async t => {
  const job = createJobHandler({ cancel: () => {} })
  const response = job.start()

  const terminalResult = { op: 'finetune', status: 'PAUSED' }
  job.end(null, terminalResult)

  const result = await response.await()
  t.is(result, terminalResult, 'await should resolve with the terminal result')
})

test('createJobHandler - end is no-op when no active response', t => {
  const job = createJobHandler({ cancel: () => {} })
  job.end({ TPS: 42 })
  t.pass('should not throw')
})

test('createJobHandler - fail calls failed on response and clears active', async t => {
  const job = createJobHandler({ cancel: () => {} })
  const response = job.start()
  let receivedError = null

  response.onError(err => { receivedError = err })

  job.fail(new Error('boom'))

  t.is(job.active, null, 'active should be null after fail')
  t.ok(receivedError, 'error listener should fire')
  t.is(receivedError.message, 'boom', 'error message should match')

  try {
    await response.await()
    t.fail('await should reject')
  } catch (err) {
    t.is(err.message, 'boom', 'await should reject with the error')
  }
})

test('createJobHandler - fail with string converts to Error', async t => {
  const job = createJobHandler({ cancel: () => {} })
  const response = job.start()
  let receivedError = null

  response.onError(err => { receivedError = err })

  job.fail('string error')

  t.ok(receivedError instanceof Error, 'should be converted to Error')
  t.is(receivedError.message, 'string error', 'message should match')
})

test('createJobHandler - fail is no-op when no active response', t => {
  const job = createJobHandler({ cancel: () => {} })
  job.fail(new Error('orphan'))
  t.pass('should not throw')
})

test('createJobHandler - start while active fails the stale response', async t => {
  const job = createJobHandler({ cancel: () => {} })
  const first = job.start()
  let firstError = null

  first.onError(err => { firstError = err })

  const second = job.start()

  t.ok(firstError, 'first response should be failed')
  t.ok(firstError.message.includes('Stale'), 'error should mention staleness')
  t.is(job.active, second, 'active should be the new response')

  try {
    await first.await()
    t.fail('first await should reject')
  } catch (err) {
    t.ok(err.message.includes('Stale'), 'first await rejects with stale error')
  }
})

test('createJobHandler - cancel handler is wired to response', async t => {
  let cancelCalled = false
  const job = createJobHandler({ cancel: () => { cancelCalled = true } })
  const response = job.start()

  await response.cancel()

  t.ok(cancelCalled, 'cancel handler should be invoked')
})

test('createJobHandler - full lifecycle: start, output, end', async t => {
  const job = createJobHandler({ cancel: () => {} })
  const updates = []
  let finished = false

  const response = job.start()
  response.onUpdate(data => updates.push(data))
  response.onFinish(() => { finished = true })

  job.output('token1')
  job.output('token2')
  job.output('token3')
  job.end({ TPS: 30 })

  const result = await response.await()

  t.alike(updates, ['token1', 'token2', 'token3'], 'all outputs received')
  t.alike(result, ['token1', 'token2', 'token3'], 'await resolves with all outputs')
  t.ok(finished, 'onFinish callback fired')
  t.alike(response.stats, { TPS: 30 }, 'stats set correctly')
  t.is(job.active, null, 'active cleared')
})

test('createJobHandler - startWith registers a custom response as active', async t => {
  const QvacResponse = require('../../src/QvacResponse')
  const job = createJobHandler({ cancel: () => {} })

  const custom = new QvacResponse({ cancelHandler: () => {} })
  const returned = job.startWith(custom)

  t.is(returned, custom, 'should return the same response')
  t.is(job.active, custom, 'active should be the custom response')

  job.output('data')
  job.end()

  const result = await custom.await()
  t.alike(result, ['data'], 'custom response receives output and ends correctly')
})

test('createJobHandler - startWith fails stale response', async t => {
  const job = createJobHandler({ cancel: () => {} })
  const first = job.start()
  let firstError = null
  first.onError(err => { firstError = err })

  const QvacResponse = require('../../src/QvacResponse')
  const custom = new QvacResponse({ cancelHandler: () => {} })
  job.startWith(custom)

  t.ok(firstError, 'first response should be failed')
  t.is(job.active, custom, 'active should be the custom response')
})

test('createJobHandler - is exported from package root', t => {
  const { createJobHandler: exported } = require('../..')
  t.is(typeof exported, 'function', 'should be exported as a function')
  t.is(exported, createJobHandler, 'should be the same function reference')
})
