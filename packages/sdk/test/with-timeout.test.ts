import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { OperationTimeoutError, withTimeout, withTimeoutStream } from '@/utils/withTimeout'

for (const afterFirst of [false, true]) {
  test(`stream timeout interrupts a stalled ${afterFirst ? 'later' : 'first'} read`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    let closed = false
    async function* source() {
      try {
        if (afterFirst) yield 'first'
        await waiting
        yield 'late'
      } finally {
        closed = true
      }
    }

    const stream = withTimeoutStream(source(), 20)
    if (afterFirst) assert.equal((await stream.next()).value, 'first')
    let settled = false
    let error: unknown
    const read = stream.next().then(
      () => {
        settled = true
      },
      (reason: unknown) => {
        settled = true
        error = reason
      }
    )
    t.after(async () => {
      release()
      await read
      await stream.return(undefined)
    })

    t.mock.timers.tick(20)
    await setImmediate()
    assert.equal(settled, true, 'the deadline does not wait for the source to produce a value')
    assert.ok(error instanceof OperationTimeoutError)
    assert.equal(error.message, 'Operation timeout after 20ms')

    release()
    await setImmediate()
    assert.equal(closed, true, 'the source is closed once its pending read settles')
  })
}

test('stream timeout resets for each read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  async function* source() {
    for (const value of ['first', 'second']) {
      await new Promise<void>((resolve) => setTimeout(resolve, 15))
      yield value
    }
  }

  const stream = withTimeoutStream(source(), 20)
  for (const value of ['first', 'second']) {
    const next = stream.next()
    t.mock.timers.tick(15)
    assert.deepEqual(await next, { value, done: false })
  }
  assert.equal((await stream.next()).done, true)
})

test('stream without a timeout waits for the source', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  async function* source() {
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    yield 'late'
  }
  const stream = withTimeoutStream(source())
  const next = stream.next()
  t.mock.timers.tick(100)
  assert.deepEqual(await next, { value: 'late', done: false })
  assert.equal((await stream.next()).done, true)
})

test('ending a timed stream early closes the source', async () => {
  let closed = false
  async function* source() {
    try {
      yield 'first'
      yield 'second'
    } finally {
      closed = true
    }
  }
  const stream = withTimeoutStream(source(), 20)
  assert.equal((await stream.next()).value, 'first')
  await stream.return(undefined)
  assert.equal(closed, true)
})

test('a source error keeps its identity', async () => {
  const failure = new Error('read failed')
  async function* source(): AsyncGenerator<string> {
    throw failure
  }
  await assert.rejects(withTimeoutStream(source(), 20).next(), (error) => error === failure)
})

test('ending a timed stream waits for asynchronous source cleanup', async () => {
  let closed = false
  async function* source() {
    try {
      yield 'first'
    } finally {
      await setImmediate()
      closed = true
    }
  }
  const stream = withTimeoutStream(source(), 20)
  await stream.next()
  await stream.return(undefined)
  assert.equal(closed, true)
})

for (const reject of [false, true]) {
  test(`settled ${reject ? 'rejected' : 'fulfilled'} operations clear their timeout`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const clear = t.mock.method(globalThis, 'clearTimeout')
    const failure = new Error('operation failed')
    const result = withTimeout(reject ? Promise.reject(failure) : Promise.resolve('done'), 20)
    if (reject) await assert.rejects(result, (error) => error === failure)
    else assert.equal(await result, 'done')
    assert.equal(clear.mock.callCount(), 1)
  })
}

test('a stalled operation rejects with the timeout error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const result = withTimeout(new Promise<never>(() => {}), 20)
  const rejected = assert.rejects(result, OperationTimeoutError)
  t.mock.timers.tick(20)
  await rejected
})
