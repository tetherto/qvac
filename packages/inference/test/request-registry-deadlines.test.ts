import test from 'brittle'
import { createRequestRegistry } from '@/runtime/request-registry'
import { DeadlineClock, type DeadlineLimits } from '@/runtime/deadlines'
import { DeadlineExceededError } from '@/errors'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function serialRegistry() {
  const r = createRequestRegistry()
  r.policy({ kind: 'completion', maxConcurrentPerModel: 1, onOverflow: 'queue' })
  return r
}

function clockFor(requestId: string, limits: DeadlineLimits, idleFromAdmission = true) {
  return new DeadlineClock(
    limits,
    { requestId, capability: 'completion', modelId: 'm1' },
    { idleFromAdmission }
  )
}

async function expiryOf(clock: DeadlineClock): Promise<DeadlineExceededError> {
  try {
    await clock.expired
  } catch (error) {
    return error as DeadlineExceededError
  }
  throw new Error('the clock never expired')
}

test('run deadline: the request is aborted, listed as overdue, and cleared once disposed', async (t) => {
  const r = serialRegistry()
  const clock = clockFor('r-run', { runMs: 30 })
  const unbind = r.bindDeadline('r-run', undefined, clock)
  const ctx = await r.begin({ requestId: 'r-run', kind: 'completion', modelId: 'm1' })

  const error = await expiryOf(clock)
  t.ok(error instanceof DeadlineExceededError)
  t.is(error.boundary, 'run')
  t.is(error.timeoutMs, 30)
  t.is(error.requestId, 'r-run')
  t.is(error.capability, 'completion')
  t.is(error.modelId, 'm1')
  t.ok(ctx.signal.aborted, 'the request was told to stop')
  t.ok(ctx.overdue)
  t.alike(
    r.overdue().map((c) => c.requestId),
    ['r-run']
  )

  await ctx[Symbol.asyncDispose]()
  t.is(r.overdue().length, 0, 'not overdue once its teardown has finished')
  unbind()
  clock.close()
})

test('queue deadline: a waiter behind a busy model fails with boundary "queue" and the holder keeps running', async (t) => {
  const r = serialRegistry()
  const holder = await r.begin({ requestId: 'holder', kind: 'completion', modelId: 'm1' })
  const clock = clockFor('waiter', { queueMs: 30, runMs: 10 })
  const unbind = r.bindDeadline('waiter', undefined, clock)

  let thrown: unknown
  try {
    await r.begin({ requestId: 'waiter', kind: 'completion', modelId: 'm1' })
  } catch (error) {
    thrown = error
  }
  t.ok(thrown instanceof DeadlineExceededError)
  t.is(
    (thrown as DeadlineExceededError).boundary,
    'queue',
    'the run deadline did not run while queued'
  )
  t.absent(holder.signal.aborted)

  unbind()
  clock.close()
  await holder[Symbol.asyncDispose]()
  const next = await r.begin({ requestId: 'next', kind: 'completion', modelId: 'm1' })
  t.is(next.state, 'running', 'the expired waiter left the queue')
  await next[Symbol.asyncDispose]()
})

test('an overdue request keeps its slot until its teardown finishes', async (t) => {
  const r = serialRegistry()
  const holderClock = clockFor('holder', { runMs: 20 })
  const unbindHolder = r.bindDeadline('holder', undefined, holderClock)
  const holder = await r.begin({ requestId: 'holder', kind: 'completion', modelId: 'm1' })
  let finishTeardown: () => void = () => {}
  holder.scope.defer(
    () =>
      new Promise<void>((resolve) => {
        finishTeardown = resolve
      })
  )

  const holderError = await expiryOf(holderClock)
  t.is(holderError.boundary, 'run', 'the caller has its error before teardown ends')
  const disposing = holder[Symbol.asyncDispose]()

  const waiterClock = clockFor('waiter', { queueMs: 30 })
  const unbindWaiter = r.bindDeadline('waiter', undefined, waiterClock)
  let waiterError: unknown
  try {
    await r.begin({ requestId: 'waiter', kind: 'completion', modelId: 'm1' })
  } catch (error) {
    waiterError = error
  }
  t.is((waiterError as DeadlineExceededError).boundary, 'queue', 'the slot was not handed over')
  t.alike(
    r.overdue().map((c) => c.requestId),
    ['holder'],
    'still overdue while teardown runs'
  )

  finishTeardown()
  await disposing
  t.is(r.overdue().length, 0)
  const next = await r.begin({ requestId: 'next', kind: 'completion', modelId: 'm1' })
  t.is(next.state, 'running', 'the slot is free after teardown')
  await next[Symbol.asyncDispose]()
  unbindHolder()
  unbindWaiter()
  holderClock.close()
  waiterClock.close()
})

test('a deadline that passes while the request is in teardown lists it as overdue', async (t) => {
  const r = serialRegistry()
  const clock = clockFor('late', { runMs: 40 })
  const unbind = r.bindDeadline('late', undefined, clock)
  const ctx = await r.begin({ requestId: 'late', kind: 'completion', modelId: 'm1' })
  let finishTeardown: () => void = () => {}
  ctx.scope.defer(
    () =>
      new Promise<void>((resolve) => {
        finishTeardown = resolve
      })
  )
  const disposing = ctx[Symbol.asyncDispose]()
  t.is(r.overdue().length, 0, 'in teardown, deadline not yet passed')

  const error = await expiryOf(clock)
  t.is(error.boundary, 'run')
  t.alike(
    r.overdue().map((c) => c.requestId),
    ['late'],
    'it still holds its slot, so it is reported'
  )

  finishTeardown()
  await disposing
  t.is(r.overdue().length, 0)
  unbind()
  clock.close()
})

test('idle deadline: progress restarts it, and a gap longer than the deadline expires it', async (t) => {
  const r = serialRegistry()
  const clock = clockFor('r-idle', { idleMs: 60 })
  const unbind = r.bindDeadline('r-idle', undefined, clock)
  const ctx = await r.begin({ requestId: 'r-idle', kind: 'completion', modelId: 'm1' })

  for (let i = 0; i < 8; i++) {
    await sleep(20)
    ctx.touch()
  }
  t.is(
    clock.error,
    undefined,
    'a run of 160ms with progress every 20ms outlives a 60ms idle deadline'
  )

  const error = await expiryOf(clock)
  t.is(error.boundary, 'idle')
  await ctx[Symbol.asyncDispose]()
  unbind()
  clock.close()
})

test('idle deadline of a single-reply call starts at the first progress event', async (t) => {
  const r = serialRegistry()
  const clock = clockFor('r-reply', { idleMs: 30 }, false)
  const unbind = r.bindDeadline('r-reply', undefined, clock)
  const ctx = await r.begin({ requestId: 'r-reply', kind: 'completion', modelId: 'm1' })

  await sleep(90)
  t.is(clock.error, undefined, 'no progress yet, so nothing to measure a gap from')
  ctx.touch()
  const error = await expiryOf(clock)
  t.is(error.boundary, 'idle')
  await ctx[Symbol.asyncDispose]()
  unbind()
  clock.close()
})

test('a child request shares its parent deadline: its queue wait is bounded and stops the run timer', async (t) => {
  const r = serialRegistry()
  const holder = await r.begin({ requestId: 'holder', kind: 'completion', modelId: 'm1' })
  const clock = clockFor('invoke', { runMs: 60 })
  const unbind = r.bindDeadline('invoke', undefined, clock)
  const parent = await r.begin({ requestId: 'invoke', kind: 'plugin', modelId: 'm1' })

  const childBegin = r.begin({
    requestId: 'inner',
    kind: 'completion',
    modelId: 'm1',
    parentSignal: parent.signal
  })
  await sleep(120)
  t.is(clock.error, undefined, 'the run deadline does not count the wait for a slot')

  await holder[Symbol.asyncDispose]()
  const child = await childBegin
  const error = await expiryOf(clock)
  t.is(error.boundary, 'run', 'the run deadline counts from admission')
  t.ok(child.signal.aborted, 'the child stops with its parent')
  t.ok(child.overdue)

  await child[Symbol.asyncDispose]()
  await parent[Symbol.asyncDispose]()
  unbind()
  clock.close()
})

test('a child request queued past the parent queue deadline fails with boundary "queue"', async (t) => {
  const r = serialRegistry()
  const holder = await r.begin({ requestId: 'holder', kind: 'completion', modelId: 'm1' })
  const clock = clockFor('invoke', { queueMs: 30 })
  const unbind = r.bindDeadline('invoke', undefined, clock)
  const parent = await r.begin({ requestId: 'invoke', kind: 'plugin', modelId: 'm1' })

  let thrown: unknown
  try {
    await r.begin({
      requestId: 'inner',
      kind: 'completion',
      modelId: 'm1',
      parentSignal: parent.signal
    })
  } catch (error) {
    thrown = error
  }
  t.is((thrown as DeadlineExceededError).boundary, 'queue')
  t.absent(holder.signal.aborted)

  await parent[Symbol.asyncDispose]()
  await holder[Symbol.asyncDispose]()
  unbind()
  clock.close()
})

test('a wait on the caller stops the run and idle deadlines until the request runs again', async (t) => {
  const r = serialRegistry()
  const clock = clockFor('turns', { runMs: 60, idleMs: 60 })
  const unbind = r.bindDeadline('turns', undefined, clock)

  const firstTurn = await r.begin({ requestId: 'turns', kind: 'completion', modelId: 'm1' })
  await firstTurn[Symbol.asyncDispose]()

  const toolWait = await r.begin({
    requestId: 'turns',
    kind: 'completion',
    modelId: 'm1',
    maxConcurrentPerModel: Infinity,
    waitsOnCaller: true
  })
  await sleep(150)
  t.is(clock.error, undefined, 'the wait for the caller is not counted')
  await toolWait[Symbol.asyncDispose]()

  const secondTurn = await r.begin({ requestId: 'turns', kind: 'completion', modelId: 'm1' })
  const error = await expiryOf(clock)
  t.ok(secondTurn.signal.aborted, 'the next turn is bounded again')
  t.ok(error.boundary === 'run' || error.boundary === 'idle')
  await secondTurn[Symbol.asyncDispose]()
  unbind()
  clock.close()
})

test('a request with no bound deadline is never overdue', async (t) => {
  const r = serialRegistry()
  const ctx = await r.begin({ requestId: 'plain', kind: 'completion', modelId: 'm1' })
  ctx.touch()
  ctx.startLoadDeadline()
  await sleep(30)
  t.absent(ctx.signal.aborted)
  t.is(r.overdue().length, 0)
  await ctx[Symbol.asyncDispose]()
})

test('load deadline: runs from startLoadDeadline, not from begin', async (t) => {
  const r = serialRegistry()
  const clock = new DeadlineClock(
    { loadMs: 30 },
    { requestId: 'load' },
    { idleFromAdmission: false }
  )
  const unbind = r.bindDeadline('load', undefined, clock)
  const ctx = await r.begin({ requestId: 'load', kind: 'loadModel' })

  await sleep(90)
  t.is(clock.error, undefined, 'the download phase is not bounded')
  ctx.startLoadDeadline()
  const error = await expiryOf(clock)
  t.is(error.boundary, 'load')
  t.is(error.capability, undefined)
  await ctx[Symbol.asyncDispose]()
  unbind()
  clock.close()
})
