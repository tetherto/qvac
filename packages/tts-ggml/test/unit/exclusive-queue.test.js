'use strict'

const test = require('brittle')
const process = require('bare-process')
const { ExclusiveResponseQueue, resolveExclusiveRunner } = require('../../lib/exclusiveQueue.js')

global.process = process

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function runPair(runner, order) {
  const gate = deferred()
  const first = runner(() => {
    order.push('first start')
    return gate.promise.then(() => order.push('first end'))
  })
  const second = runner(async () => {
    order.push('second start')
  })
  await tick()
  const beforeRelease = [...order]
  gate.resolve()
  await first
  await second
  return beforeRelease
}

test('exclusive queue: plain runs are serialized only under exclusiveRun', async (t) => {
  const parallel = []
  t.alike(
    await runPair(resolveExclusiveRunner(false), parallel),
    ['first start', 'second start'],
    'without exclusiveRun both start at once'
  )
  const serial = []
  t.alike(
    await runPair(resolveExclusiveRunner(true), serial),
    ['first start'],
    'with exclusiveRun the second waits'
  )
  t.alike(serial, ['first start', 'first end', 'second start'])
})

test('exclusive queue: a streaming response holds the next one until it settles', async (t) => {
  const queue = new ExclusiveResponseQueue()
  const first = deferred()
  const starts = []
  const a = await queue.enqueue(() => {
    starts.push('a')
    return { await: () => first.promise }
  })
  t.ok(a, 'the first stream starts at once')
  const pending = queue.enqueue(() => {
    starts.push('b')
    return { await: () => Promise.resolve([]) }
  })
  await tick()
  t.alike(starts, ['a'], 'b waits for a to settle')
  first.reject(new Error('a failed'))
  const b = await pending
  t.alike(starts, ['a', 'b'], 'a rejected response still releases its slot')
  t.ok(b)
})

test('exclusive queue: a run that throws rejects its caller and frees the slot', async (t) => {
  const queue = new ExclusiveResponseQueue()
  await t.exception(
    queue.enqueue(() => {
      throw new Error('no chunks')
    }),
    /no chunks/
  )
  const next = await queue.enqueue(() => ({ await: () => Promise.resolve([]) }))
  t.ok(next, 'the next stream is not held up')
})
