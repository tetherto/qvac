'use strict'

const test = require('brittle')
const process = require('bare-process')
const { PocketLifecycle } = require('../../lib/pocketLifecycle.js')
const { resolveEngineSetup } = require('../../lib/setup.js')

global.process = process

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function fakeAddon(events, id) {
  return {
    activate: async () => {
      events.push(`activate ${id}`)
    },
    cancel: async () => {
      events.push(`cancel ${id}`)
    },
    destroyInstance: async () => {
      events.push(`destroy ${id}`)
    },
    runJob: async (data) => {
      events.push(`run ${data.input}`)
    }
  }
}

// The wrapper's side of the host interface, with a loaded Pocket instance.
function fakeHost() {
  const events = []
  const host = {
    events,
    setup: resolveEngineSetup({ engine: 'pocket', files: { modelDir: '/models/pocket' } }),
    state: { configLoaded: true, weightsLoaded: true, destroyed: false },
    addon: fakeAddon(events, 1),
    active: null,
    created: 1,
    logged: [],
    logger: () => ({ error: (...args) => host.logged.push(args) }),
    optionalAddon: () => host.addon,
    setAddon: (addon) => {
      host.addon = addon
    },
    createAddon: () => {
      const id = ++host.created
      events.push(`create ${id}`)
      return fakeAddon(events, id)
    },
    unloadModel: async () => {
      events.push('unload')
      host.addon = null
      host.state.configLoaded = false
      host.state.weightsLoaded = false
    },
    activeJob: () => host.active,
    failStream: (reason) => events.push(`fail ${reason}`)
  }
  return host
}

function fakeSignal(reason, listeners) {
  return {
    reason,
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener)
  }
}

test('pocket lifecycle: a request needs a loaded instance, no job in flight and no operation running', (t) => {
  const host = fakeHost()
  const pocket = new PocketLifecycle(host)
  t.execution(() => pocket.checkRequest())
  host.active = {}
  t.exception(() => pocket.checkRequest(), /synthesis is already in progress/)
  host.active = null
  host.addon = null
  t.exception(() => pocket.checkRequest(), /not loaded/, 'no native instance')
  host.addon = fakeAddon(host.events, 1)
  host.state.weightsLoaded = false
  t.exception(() => pocket.checkRequest(), /not loaded/, 'weights not loaded')
  host.state.weightsLoaded = true
  host.state.destroyed = true
  t.exception(() => pocket.checkRequest(), /destroyed/)
})

test('pocket lifecycle: one lifecycle operation at a time, released even when it throws', async (t) => {
  const pocket = new PocketLifecycle(fakeHost())
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const running = pocket.withLifecycle(() => gate)
  await tick()
  t.exception(() => pocket.checkReload(), /lifecycle operation is already in progress/)
  t.exception(() => pocket.checkRequest(), /lifecycle operation is already in progress/)
  await t.exception(
    pocket.withLifecycle(async () => {}),
    /already in progress/
  )
  release()
  await running
  t.execution(() => pocket.checkReload())
  await t.exception(
    pocket.withLifecycle(async () => {
      throw new Error('boom')
    }),
    /boom/
  )
  t.execution(() => pocket.checkReload(), 'a failed operation releases the lock')
})

test('pocket lifecycle: the completion barrier holds until the terminal callback', async (t) => {
  const host = fakeHost()
  const pocket = new PocketLifecycle(host)
  await pocket.runJob(host.addon, { type: 'text', input: 'One.' })
  t.ok(pocket.jobPending, 'the job is pending after the native call returns')
  await t.exception(
    pocket.runJob(host.addon, { type: 'text', input: 'Two.' }),
    /native job is already in progress/
  )
  let settled = false
  void pocket.jobPending.promise.then(() => {
    settled = true
  })
  pocket.onNativeEvent({ outputArray: new Int16Array(1) }, null)
  await tick()
  t.absent(settled, 'audio does not end the job')
  pocket.onNativeEvent(null, '')
  await tick()
  t.absent(settled, 'an empty error string is not terminal')
  pocket.onNativeEvent({ totalTime: 0.1 }, null)
  await tick()
  t.ok(settled, 'stats end the job')
  t.is(pocket.jobPending, null)
  t.execution(() => pocket.onNativeEvent(null, 'late'), 'a terminal event with no job is ignored')
  await pocket.runJob(host.addon, { type: 'text', input: 'Three.' })
  pocket.onNativeEvent(null, 'Job cancelled')
  t.is(pocket.jobPending, null, 'an error string ends the job')
  t.alike(host.events, ['run One.', 'run Three.'])
})

test('pocket lifecycle: a rejected native dispatch clears the barrier and resolves it', async (t) => {
  const host = fakeHost()
  host.addon.runJob = async () => {
    throw new Error('busy')
  }
  const pocket = new PocketLifecycle(host)
  const running = pocket.runJob(host.addon, { type: 'text', input: 'x' })
  const pending = pocket.jobPending
  t.ok(pending, 'the barrier is up while the native call is pending')
  await t.exception(running, /busy/)
  t.is(pocket.jobPending, null)
  await pending.promise
  t.pass('the barrier of a rejected dispatch resolves')
})

test('pocket lifecycle: cancel fails the stream, stops native work and drains the job in flight', async (t) => {
  const host = fakeHost()
  const pocket = new PocketLifecycle(host)
  await pocket.waitCancel()
  await pocket.runJob(host.addon, { type: 'text', input: 'One.' })
  let cancelled = false
  const cancelling = pocket.cancel().then(() => {
    cancelled = true
  })
  const again = pocket.cancel()
  let waited = false
  const waiting = pocket.waitCancel().then(() => {
    waited = true
  })
  await tick()
  t.alike(host.events, ['run One.', 'fail Synthesis cancelled', 'cancel 1'])
  t.absent(cancelled, 'cancel waits for the terminal callback')
  t.absent(waited, 'so does whoever waits on the cancel')
  pocket.onNativeEvent(null, 'Job cancelled')
  await cancelling
  await again
  await waiting
  t.ok(cancelled)
  t.ok(waited)
  t.is(
    host.events.filter((event) => event === 'cancel 1').length,
    1,
    'concurrent cancels share one'
  )
  await pocket.cancel()
  t.is(host.events.filter((event) => event === 'cancel 1').length, 2, 'a later cancel is new')
  host.addon = null
  await pocket.cancel()
  t.pass('cancel without a native instance only fails the stream')
})

test('pocket lifecycle: an abort fails the active response with the caller reason and cancels', async (t) => {
  const host = fakeHost()
  const pocket = new PocketLifecycle(host)
  const listeners = new Set()
  const failures = []
  let settle
  const response = {
    failed: (error) => failures.push(error),
    await: () =>
      new Promise((resolve) => {
        settle = resolve
      })
  }
  host.active = response
  const reason = new Error('Caller aborted')
  pocket.attachAbort(response, fakeSignal(reason, listeners))
  t.is(listeners.size, 1)
  for (const listener of [...listeners]) listener()
  await tick()
  t.is(failures.length, 1)
  t.is(failures[0], reason, 'an Error reason is passed through')
  t.alike(host.events, ['fail Synthesis cancelled', 'cancel 1'], 'native work is cancelled')
  settle()
  await tick()
  t.is(listeners.size, 0, 'the listener is detached once the response settles')

  host.active = null
  const stale = {
    failed: () => t.fail('a response that is no longer active is left alone'),
    await: () => new Promise(() => {})
  }
  pocket.attachAbort(stale, fakeSignal('user left', listeners))
  for (const listener of [...listeners]) listener()
  await tick()
  t.is(failures.length, 1)

  listeners.clear()
  host.events.length = 0
  host.addon.cancel = async () => {
    throw new Error('native cancel failed')
  }
  const second = { failed: (error) => failures.push(error), await: () => new Promise(() => {}) }
  host.active = second
  pocket.attachAbort(second, fakeSignal('user left', listeners))
  for (const listener of [...listeners]) listener()
  await tick()
  t.is(failures[1].message, 'Aborted: user left', 'a string reason is wrapped')
  t.is(host.logged.length, 1, 'a failed cancellation is logged, not thrown')
  t.is(host.logged[0][0], 'Pocket abort cancellation failed')
})

test('pocket lifecycle: reload releases the old model before the replacement and updates the setup', async (t) => {
  const host = fakeHost()
  const pocket = new PocketLifecycle(host)
  const files = host.setup.pocket.files
  await pocket.reload({ outputSampleRate: 44100, steps: 2 })
  t.alike(host.events, ['unload', 'create 2', 'activate 2'])
  t.is(host.created, 2, 'the replacement is the live instance')
  t.is(host.setup.pocket.files, files)
  t.is(host.setup.pocket.options.steps, 2)
  t.is(host.setup.pocket.params.steps, 2)
  t.is(host.setup.pocket.params.outputSampleRate, 44100)
  t.is(host.setup.outputSampleRate, 44100)
  t.is(host.setup.config.outputSampleRate, 44100)
  t.is(host.setup.config.language, 'en')
  t.is(host.setup.config.useGPU, false)
  t.ok(host.state.configLoaded)
  t.ok(host.state.weightsLoaded)
  t.execution(() => pocket.checkReload(), 'the lock is released')
})

test('pocket lifecycle: reload validates before it touches the model and refuses the wrong state', async (t) => {
  const host = fakeHost()
  const pocket = new PocketLifecycle(host)
  await t.exception(pocket.reload({ useGPU: true }))
  t.alike(host.events, [], 'a rejected option leaves the loaded model alone')
  t.ok(host.state.weightsLoaded)

  const destroyed = fakeHost()
  destroyed.state.destroyed = true
  await t.exception(new PocketLifecycle(destroyed).reload({}), /destroyed/)

  const unconfigured = fakeHost()
  unconfigured.setup.pocket = null
  await t.exception(new PocketLifecycle(unconfigured).reload({}), /not configured/)
  t.alike(unconfigured.events, [])
})

test('pocket lifecycle: a failed replacement is disposed and the last good configuration stays', async (t) => {
  const host = fakeHost()
  host.createAddon = () => {
    host.events.push('create 2')
    const replacement = fakeAddon(host.events, 2)
    replacement.activate = async () => {
      throw new Error('activation failed')
    }
    return replacement
  }
  const pocket = new PocketLifecycle(host)
  await t.exception(pocket.reload({ outputSampleRate: 44100 }), /activation failed/)
  t.alike(host.events, ['unload', 'create 2', 'destroy 2'])
  t.is(host.addon, null, 'the instance is left unloaded')
  t.is(host.setup.outputSampleRate, null)
  t.absent(host.state.weightsLoaded)
  t.execution(() => pocket.checkReload(), 'the lock is released')
})
