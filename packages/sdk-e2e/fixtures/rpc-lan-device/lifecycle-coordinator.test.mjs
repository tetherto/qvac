import test from 'node:test'
import assert from 'node:assert/strict'
import { createLifecycleCoordinator } from './lifecycle-coordinator.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(overrides = {}) {
  const calls = []
  const transitions = []
  let state = 'active'
  const engine = {
    async suspend() {
      calls.push('suspend')
      state = 'suspended'
    },
    async resume() {
      calls.push('resume')
      state = 'active'
    },
    async state() {
      calls.push('state')
      return state
    },
    async close() {
      calls.push('close')
    },
    ontransition(transition) {
      transitions.push(transition)
    },
    ...overrides
  }
  return { coordinator: createLifecycleCoordinator(engine), calls, transitions }
}

test('repeated OS events do not repeat successful transitions', async () => {
  const { coordinator, calls, transitions } = fixture()
  await coordinator.setForeground(true)
  await Promise.all([coordinator.setForeground(false), coordinator.setForeground(false)])
  await coordinator.setForeground(true)
  await coordinator.setForeground(true)
  assert.deepEqual(calls, ['resume', 'state', 'suspend', 'state', 'resume', 'state'])
  assert.deepEqual(
    transitions.map(({ runtimeState }) => runtimeState),
    ['active', 'suspended', 'active']
  )
})

test('foregrounding during suspension waits for resume before dispatch', async () => {
  const suspending = deferred()
  const suspended = deferred()
  const { coordinator, calls } = fixture({
    async suspend() {
      calls.push('suspend')
      suspending.resolve()
      await suspended.promise
    },
    async state() {
      calls.push('state')
      return calls.at(-2) === 'suspend' ? 'suspended' : 'active'
    }
  })
  await coordinator.setForeground(true)
  const background = coordinator.setForeground(false)
  await suspending.promise
  const foreground = coordinator.setForeground(true)
  let ran = false
  const work = coordinator.run(async () => {
    calls.push('task')
    ran = true
  })
  await Promise.resolve()
  assert.equal(ran, false)
  suspended.resolve()
  await Promise.all([background, foreground, work])
  assert.deepEqual(calls.slice(-5), ['suspend', 'state', 'resume', 'state', 'task'])
})

test('background suspends an in-flight task and queued tasks wait for foreground', async () => {
  const started = deferred()
  const finished = deferred()
  const { coordinator, calls } = fixture()
  await coordinator.setForeground(true)
  const running = coordinator.run(async () => {
    calls.push('long task')
    started.resolve()
    await finished.promise
  })
  await started.promise
  await coordinator.setForeground(false)
  assert.equal(calls.at(-2), 'suspend')
  let nextRan = false
  const next = coordinator.run(async () => {
    nextRan = true
  })
  finished.resolve()
  await running
  assert.equal(nextRan, false)
  await coordinator.setForeground(true)
  await next
  assert.equal(nextRan, true)
})

test('manual resume respects background state', async () => {
  const { coordinator, calls } = fixture()
  await coordinator.setForeground(true)
  await coordinator.suspend()
  await coordinator.setForeground(false)
  await coordinator.resume()
  const resumes = calls.filter((call) => call === 'resume').length
  assert.equal(resumes, 1)
  await coordinator.setForeground(true)
  assert.equal(calls.filter((call) => call === 'resume').length, 2)
})

test('a failed transition reports actual runtime state and blocks dispatch until recovery', async () => {
  let fail = true
  const { coordinator, calls, transitions } = fixture({
    async resume() {
      calls.push('resume')
      if (fail) throw new Error('resume failed')
    }
  })
  await assert.rejects(coordinator.setForeground(true), /resume failed/)
  await assert.rejects(
    coordinator.run(async () => calls.push('task')),
    /resume failed/
  )
  assert.equal(transitions[0].outcome, 'failed')
  assert.equal(transitions[0].runtimeState, 'active')
  fail = false
  await coordinator.setForeground(true)
  await coordinator.run(async () => calls.push('task'))
  assert.equal(calls.at(-1), 'task')
})

test('close fences pending resumes, state queries and late task continuations', async () => {
  const entered = deferred()
  const release = deferred()
  const taskStarted = deferred()
  const taskFinished = deferred()
  const { coordinator, calls, transitions } = fixture({
    async suspend() {
      calls.push('suspend')
      entered.resolve()
      await release.promise
    }
  })
  await coordinator.setForeground(true)
  const task = coordinator.run(async () => {
    taskStarted.resolve()
    await taskFinished.promise
    return 'late result'
  })
  await taskStarted.promise
  const background = coordinator.setForeground(false)
  await entered.promise
  const foreground = coordinator.setForeground(true)
  const queued = coordinator.run(async () => calls.push('unexpected task'))
  const rejectedTask = assert.rejects(task, /closing or closed/)
  const rejectedQueued = assert.rejects(queued, /closing or closed/)
  const closing = coordinator.close(async () => calls.push('cleanup'))
  assert.equal(coordinator.close(), closing)
  release.resolve()
  taskFinished.resolve()
  await Promise.all([background, foreground, closing, rejectedTask, rejectedQueued])
  assert.deepEqual(calls, ['resume', 'state', 'suspend', 'cleanup', 'close'])
  assert.equal(coordinator.closed, true)
  assert.equal(transitions.at(-1).closed, true)
  assert.equal(transitions.at(-1).runtimeState, undefined)
  assert.throws(() => coordinator.setForeground(true), /closing or closed/)
  assert.throws(() => coordinator.resume(), /closing or closed/)
  await assert.rejects(
    coordinator.run(async () => calls.push('unexpected task')),
    /closing or closed/
  )
})

test('cleanup failure still closes the engine and keeps the terminal fence', async () => {
  const { coordinator, calls } = fixture()
  await coordinator.setForeground(true)
  const closing = coordinator.close(async () => {
    throw new Error('stop failed')
  })
  await assert.rejects(
    closing,
    (error) => error instanceof AggregateError && error.errors[0].message === 'stop failed'
  )
  assert.equal(coordinator.closed, true)
  assert.equal(calls.at(-1), 'close')
  assert.throws(() => coordinator.resume(), /closing or closed/)
})

test('an unexpected runtime state fails the transition', async () => {
  const { coordinator } = fixture({
    async state() {
      return 'resuming'
    }
  })
  await assert.rejects(
    coordinator.setForeground(true),
    /Expected runtime active, observed resuming/
  )
  await assert.rejects(
    coordinator.run(async () => {}),
    /observed resuming/
  )
})

test('engine close failure keeps teardown terminal and preserves the shared failure', async () => {
  const { coordinator, calls, transitions } = fixture({
    async close() {
      calls.push('close')
      throw new Error('close failed')
    }
  })
  await coordinator.setForeground(true)
  const closing = coordinator.close()
  await assert.rejects(
    closing,
    (error) => error instanceof AggregateError && error.errors[0].message === 'close failed'
  )
  assert.equal(coordinator.close(), closing)
  assert.equal(coordinator.closed, false)
  assert.equal(transitions.at(-1).outcome, 'failed')
  assert.equal(transitions.at(-1).runtimeState, undefined)
  assert.throws(() => coordinator.resume(), /closing or closed/)
  assert.deepEqual(calls, ['resume', 'state', 'close'])
})
