'use strict'

const test = require('brittle')
const exclusiveRunQueue = require('../../src/exclusiveRunQueue')

test('exclusiveRunQueue - serializes concurrent calls', async t => {
  const withExclusiveRun = exclusiveRunQueue()
  const order = []

  const p1 = withExclusiveRun(async () => {
    order.push('start-1')
    await new Promise(resolve => setTimeout(resolve, 50))
    order.push('end-1')
    return 'a'
  })

  const p2 = withExclusiveRun(async () => {
    order.push('start-2')
    await new Promise(resolve => setTimeout(resolve, 10))
    order.push('end-2')
    return 'b'
  })

  const p3 = withExclusiveRun(async () => {
    order.push('start-3')
    return 'c'
  })

  const results = await Promise.all([p1, p2, p3])

  t.alike(order, ['start-1', 'end-1', 'start-2', 'end-2', 'start-3'], 'calls run sequentially')
  t.alike(results, ['a', 'b', 'c'], 'returns values from each call')
})

test('exclusiveRunQueue - releases queue even when fn throws', async t => {
  const withExclusiveRun = exclusiveRunQueue()

  const p1 = withExclusiveRun(async () => {
    throw new Error('boom')
  }).catch(e => e.message)

  const p2 = withExclusiveRun(async () => 'ok')

  const [err, result] = await Promise.all([p1, p2])

  t.is(err, 'boom', 'first call should throw')
  t.is(result, 'ok', 'second call should still run after error')
})

test('exclusiveRunQueue - separate queues are independent', async t => {
  const q1 = exclusiveRunQueue()
  const q2 = exclusiveRunQueue()
  const order = []

  const p1 = q1(async () => {
    order.push('q1-start')
    await new Promise(resolve => setTimeout(resolve, 50))
    order.push('q1-end')
  })

  const p2 = q2(async () => {
    order.push('q2-start')
    await new Promise(resolve => setTimeout(resolve, 10))
    order.push('q2-end')
  })

  await Promise.all([p1, p2])

  t.is(order[0], 'q1-start', 'q1 starts first')
  t.is(order[1], 'q2-start', 'q2 starts before q1 finishes (independent)')
})
