'use strict'

const test = require('brittle')
const exclusiveRunQueue = require('../../src/utils/exclusiveRunQueue')

test('exclusiveRunQueue - returns result of the executed function', async t => {
  const run = exclusiveRunQueue()
  const result = await run(() => Promise.resolve(42))
  t.is(result, 42, 'should return resolved value')
})

test('exclusiveRunQueue - serializes concurrent calls', async t => {
  const run = exclusiveRunQueue()
  const order = []

  const a = run(async () => {
    order.push('a-start')
    await sleep(50)
    order.push('a-end')
    return 'a'
  })

  const b = run(async () => {
    order.push('b-start')
    await sleep(10)
    order.push('b-end')
    return 'b'
  })

  const c = run(async () => {
    order.push('c-start')
    order.push('c-end')
    return 'c'
  })

  const results = await Promise.all([a, b, c])

  t.alike(results, ['a', 'b', 'c'], 'all results returned correctly')
  t.alike(order, [
    'a-start', 'a-end',
    'b-start', 'b-end',
    'c-start', 'c-end'
  ], 'calls must run strictly in order')
})

test('exclusiveRunQueue - error in one call does not block subsequent calls', async t => {
  const run = exclusiveRunQueue()

  try {
    await run(() => Promise.reject(new Error('boom')))
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'boom', 'error propagated')
  }

  const result = await run(() => Promise.resolve('ok'))
  t.is(result, 'ok', 'queue continues after error')
})

test('exclusiveRunQueue - synchronous throw is propagated', async t => {
  const run = exclusiveRunQueue()

  try {
    await run(() => { throw new Error('sync boom') })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'sync boom', 'sync error propagated')
  }

  const result = await run(() => Promise.resolve('still ok'))
  t.is(result, 'still ok', 'queue continues after sync throw')
})

test('exclusiveRunQueue - separate queues are independent', async t => {
  const runA = exclusiveRunQueue()
  const runB = exclusiveRunQueue()
  const order = []

  const a = runA(async () => {
    order.push('a-start')
    await sleep(50)
    order.push('a-end')
  })

  const b = runB(async () => {
    order.push('b-start')
    order.push('b-end')
  })

  await Promise.all([a, b])

  t.is(order[0], 'a-start', 'a starts first')
  t.is(order[1], 'b-start', 'b starts without waiting for a (separate queue)')
})

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
