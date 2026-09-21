'use strict'

const test = require('brittle')
const { AudioGen, ERR_CODE_RANGE, ERR_CODES, QvacErrorAudioGen } = require('../../index.js')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createHarness(runJob) {
  const gen = new AudioGen()
  let cancelCalls = 0
  let destroyCalls = 0
  gen.addon = {
    runJob,
    cancel() {
      cancelCalls++
      return Promise.resolve()
    },
    destroyInstance() {
      destroyCalls++
      return Promise.resolve()
    }
  }
  return {
    gen,
    cancelCalls: () => cancelCalls,
    destroyCalls: () => destroyCalls
  }
}

function emitPcm(gen, value) {
  gen._addonOutputCallback(
    null,
    null,
    { outputArray: new Int16Array([value]), sampleRate: 48000, channels: 2 },
    null
  )
}

function emitEnd(gen, totalTimeMs = 1) {
  gen._addonOutputCallback(null, null, { totalTimeMs }, null)
}

async function errorCode(promise) {
  try {
    await promise
  } catch (error) {
    return error.code
  }
  return undefined
}

test('overlapping runs wait for response settlement before next admission', async (t) => {
  let admissions = 0
  const { gen } = createHarness(() => {
    admissions++
    return Promise.resolve(true)
  })

  const first = await gen.run('first')
  const secondPromise = gen.run('second')
  await Promise.resolve()
  t.is(admissions, 1, 'second run is not admitted while first response is active')

  emitEnd(gen)
  await first.await()
  const second = await secondPromise
  t.is(admissions, 2, 'second run is admitted after first response settles')
  emitEnd(gen)
  await second.await()
})

test('native admission false rejects with a structured error', async (t) => {
  const { gen } = createHarness(() => Promise.resolve(false))
  const code = await errorCode(gen.run('rejected'))
  t.is(code, ERR_CODES.JOB_ALREADY_RUNNING)
  t.is(gen._job.active, null)
})

test('native admission requires an explicit true result', async (t) => {
  const { gen } = createHarness(() => Promise.resolve(undefined))
  const code = await errorCode(gen.run('invalid admission'))
  t.is(code, ERR_CODES.JOB_ALREADY_RUNNING)
  t.is(gen._job.active, null)
})

test('native admission exceptions use a structured error', async (t) => {
  const { gen } = createHarness(() => Promise.reject(new Error('native failure')))
  const code = await errorCode(gen.run('failed admission'))
  t.is(code, ERR_CODES.FAILED_TO_START_JOB)
  t.is(gen._job.active, null)
})

test('invalid input uses a structured error', async (t) => {
  const { gen } = createHarness(() => Promise.resolve(true))
  t.is(await errorCode(gen.run('')), ERR_CODES.INVALID_INPUT)
})

test('cancel settles the active response', async (t) => {
  const { gen, cancelCalls } = createHarness(() => Promise.resolve(true))
  const response = await gen.run('cancel me')

  const cancellation = gen.cancel()
  emitEnd(gen)
  await cancellation

  t.is(cancelCalls(), 1)
  t.is(await errorCode(response.await()), ERR_CODES.CANCELLED)
})

test('cancel consumes the native cancellation error before settling', async (t) => {
  const { gen } = createHarness(() => Promise.resolve(true))
  const response = await gen.run('cancel with native error')

  const cancellation = gen.cancel()
  gen._addonOutputCallback(null, null, null, 'MiniMax generation cancelled')
  await cancellation

  t.is(await errorCode(response.await()), ERR_CODES.CANCELLED)
})

test('cancel does not wedge when the pending job fails to start', async (t) => {
  const admission = deferred()
  const { gen, cancelCalls } = createHarness(() => admission.promise)

  const run = gen.run('cancel during admission')
  for (let tick = 0; tick < 100 && !gen._job.active; tick++) await Promise.resolve()
  t.ok(gen._job.active, 'job is admitted and awaiting runJob')

  const cancellation = gen.cancel()
  admission.reject(new Error('native admission failed'))

  t.is(await errorCode(run), ERR_CODES.FAILED_TO_START_JOB)
  await cancellation
  t.is(cancelCalls(), 1)

  await gen.cancel()
  t.is(cancelCalls(), 1, 'a later cancel is not stuck on a cached promise')
})

test('cancel does not wedge when the pending job is refused', async (t) => {
  const admission = deferred()
  const { gen } = createHarness(() => admission.promise)

  const run = gen.run('cancel during refused admission')
  for (let tick = 0; tick < 100 && !gen._job.active; tick++) await Promise.resolve()
  t.ok(gen._job.active, 'job is admitted and awaiting runJob')

  const cancellation = gen.cancel()
  admission.resolve(false)

  t.is(await errorCode(run), ERR_CODES.JOB_ALREADY_RUNNING)
  await cancellation
  t.pass('cancel settled without a native terminal event')
})

test('cancel on an idle instance does not invoke native cancellation', async (t) => {
  const { gen, cancelCalls } = createHarness(() => Promise.resolve(true))

  await gen.cancel()

  t.is(cancelCalls(), 0)
})

test('cancel holds the next admission until native cancellation finishes', async (t) => {
  const cancellation = deferred()
  let admissions = 0
  const { gen } = createHarness(() => {
    admissions++
    return Promise.resolve(true)
  })
  gen.addon.cancel = () => cancellation.promise
  const first = await gen.run('first')
  const secondPromise = gen.run('second')

  const cancelPromise = gen.cancel()
  await Promise.resolve()
  t.is(admissions, 1)

  cancellation.resolve()
  await Promise.resolve()
  t.is(admissions, 1, 'second run waits for the cancelled native terminal event')
  emitEnd(gen)
  await cancelPromise
  t.is(await errorCode(first.await()), ERR_CODES.CANCELLED)
  const second = await secondPromise
  t.is(admissions, 2)
  emitEnd(gen)
  await second.await()
})

test('cancel ignores terminal callbacks until native cancellation finishes', async (t) => {
  const cancellation = deferred()
  const { gen } = createHarness(() => Promise.resolve(true))
  gen.addon.cancel = () => cancellation.promise
  const response = await gen.run('cancel race')

  const cancelPromise = gen.cancel()
  emitEnd(gen)
  await Promise.resolve()

  t.is(gen._job.active, response)
  cancellation.resolve()
  await cancelPromise
  t.is(await errorCode(response.await()), ERR_CODES.CANCELLED)
})

test('concurrent cancellation requests share one native cancellation', async (t) => {
  const cancellation = deferred()
  let nativeCancelCalls = 0
  const { gen } = createHarness(() => Promise.resolve(true))
  gen.addon.cancel = () => {
    nativeCancelCalls++
    return cancellation.promise
  }
  const response = await gen.run('cancel once')

  const first = gen.cancel()
  const second = gen.cancel()
  cancellation.resolve()
  emitEnd(gen)
  await Promise.all([first, second])

  t.is(nativeCancelCalls, 1)
  t.is(await errorCode(response.await()), ERR_CODES.CANCELLED)
})

test('cancel failure rejects both cancellation and the active response', async (t) => {
  const { gen } = createHarness(() => Promise.resolve(true))
  gen.addon.cancel = () => Promise.reject(new Error('cancel failure'))
  const response = await gen.run('cancel failure')

  t.is(await errorCode(gen.cancel()), ERR_CODES.FAILED_TO_CANCEL)
  t.is(await errorCode(response.await()), ERR_CODES.FAILED_TO_CANCEL)
})

test('unload cancels and fails an active response before destruction', async (t) => {
  const { gen, cancelCalls, destroyCalls } = createHarness(() => Promise.resolve(true))
  const response = await gen.run('unload me')

  await gen.unload()

  t.is(cancelCalls(), 1)
  t.is(await errorCode(response.await()), ERR_CODES.MODEL_UNLOADED)
  t.is(destroyCalls(), 1)
  t.is(gen.addon, null)
})

test('unload settles an active response when native destruction fails', async (t) => {
  const { gen } = createHarness(() => Promise.resolve(true))
  gen.addon.destroyInstance = () => Promise.reject(new Error('destroy failure'))
  const response = await gen.run('destroy failure')

  t.is(await errorCode(gen.unload()), ERR_CODES.FAILED_TO_DESTROY)
  t.is(gen.addon, null)
  t.is(await errorCode(response.await()), ERR_CODES.MODEL_UNLOADED)
})

test('cancellation failure takes precedence when destruction also fails', async (t) => {
  const { gen } = createHarness(() => Promise.resolve(true))
  gen.addon.cancel = () => Promise.reject(new Error('cancel failure'))
  gen.addon.destroyInstance = () => Promise.reject(new Error('destroy failure'))
  const response = await gen.run('stop failures')

  t.is(await errorCode(gen.unload()), ERR_CODES.FAILED_TO_CANCEL)
  t.is(gen.addon, null)
  t.is(await errorCode(response.await()), ERR_CODES.MODEL_UNLOADED)
})

test('unload invalidates an in-flight load and destroys its addon once', async (t) => {
  const activation = deferred()
  let destroyCalls = 0
  const gen = new AudioGen()
  gen._createAddon = () => ({
    activate: () => activation.promise,
    runJob: () => Promise.resolve(true),
    cancel: () => Promise.resolve(),
    destroyInstance: () => {
      destroyCalls++
      return Promise.resolve()
    }
  })

  const loadPromise = gen.load()
  await Promise.resolve()
  const unloadPromise = gen.unload()
  activation.resolve()

  t.is(await errorCode(loadPromise), ERR_CODES.NOT_LOADED)
  await unloadPromise
  t.is(destroyCalls, 1)
  t.is(gen.addon, null)
})

test('native load failure uses a structured error and releases the addon', async (t) => {
  let destroyCalls = 0
  const gen = new AudioGen()
  gen._createAddon = () => ({
    activate: () => Promise.reject(new Error('load failure')),
    runJob: () => Promise.resolve(true),
    cancel: () => Promise.resolve(),
    destroyInstance: () => {
      destroyCalls++
      return Promise.resolve()
    }
  })

  t.is(await errorCode(gen.load()), ERR_CODES.FAILED_TO_LOAD)
  t.is(destroyCalls, 1)
  t.is(gen.addon, null)
})

test('unload fails a response while native admission is pending', async (t) => {
  const admission = deferred()
  const { gen, destroyCalls } = createHarness(() => admission.promise)
  const responsePromise = gen.run('pending admission')
  await Promise.resolve()

  const unloadPromise = gen.unload()
  admission.resolve(true)

  const response = await responsePromise
  t.is(await errorCode(response.await()), ERR_CODES.MODEL_UNLOADED)
  await unloadPromise
  t.is(destroyCalls(), 1)
})

test('unload invalidates a queued load', async (t) => {
  const { gen } = createHarness(() => Promise.resolve(true))
  const response = await gen.run('active run')
  const loadPromise = gen.load()

  await gen.unload()

  t.is(await errorCode(response.await()), ERR_CODES.MODEL_UNLOADED)
  t.is(await errorCode(loadPromise), ERR_CODES.NOT_LOADED)
  t.is(gen.addon, null)
})

test('serialized runs retain output ownership', async (t) => {
  const { gen } = createHarness(() => Promise.resolve(true))
  const first = await gen.run('first owner')
  const secondPromise = gen.run('second owner')

  emitPcm(gen, 11)
  emitEnd(gen, 2)
  await first.await()

  const second = await secondPromise
  emitPcm(gen, 22)
  emitEnd(gen, 3)
  await second.await()

  t.is(first.output.length, 1)
  t.is(first.output[0].outputArray[0], 11)
  t.is(second.output.length, 1)
  t.is(second.output[0].outputArray[0], 22)
})

test('native inference failure rejects the response with a structured error', async (t) => {
  const { gen } = createHarness(() => Promise.resolve(true))
  const response = await gen.run('native error')

  gen._addonOutputCallback(null, null, null, 'inference failure')

  t.is(await errorCode(response.await()), ERR_CODES.INFERENCE_FAILED)
  t.is(gen._job.active, null)
})

test('destroy is terminal while unload permits loading again', async (t) => {
  const unloadHarness = createHarness(() => Promise.resolve(true))
  await unloadHarness.gen.unload()
  t.is(await errorCode(unloadHarness.gen.run('not loaded')), ERR_CODES.NOT_LOADED)
  unloadHarness.gen._createAddon = () => ({
    activate: () => Promise.resolve(),
    runJob: () => Promise.resolve(true),
    cancel: () => Promise.resolve(),
    destroyInstance: () => Promise.resolve()
  })
  await unloadHarness.gen.load()
  t.ok(unloadHarness.gen.addon, 'unloaded instance can load again')

  const destroyHarness = createHarness(() => Promise.resolve(true))
  await destroyHarness.gen.destroy()
  t.is(await errorCode(destroyHarness.gen.run('destroyed')), ERR_CODES.INSTANCE_DESTROYED)
  t.is(await errorCode(destroyHarness.gen.load()), ERR_CODES.INSTANCE_DESTROYED)
})

test('public errors are exported from the package root', (t) => {
  const error = new QvacErrorAudioGen({ code: ERR_CODES.INVALID_INPUT, adds: 'bad value' })
  t.ok(error instanceof Error)
  t.is(error.code, ERR_CODES.INVALID_INPUT)
  t.ok(error.message.includes('bad value'))
  t.alike(ERR_CODE_RANGE, { start: 31001, end: 32000 })
})
