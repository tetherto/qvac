'use strict'

/**
 * Unit tests for the TranslationNmtcpp wrapper lifecycle and serialization,
 * driven against the real class with an injected fake native interface
 * (model._createAddon override). No native prebuild or model files required —
 * the binding is resolved lazily on first native use.
 */

const test = require('brittle')
const TranslationNmtcpp = require('../..')

function tick(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeModel({ params, opts, config, addonOverrides } = {}) {
  const model = new TranslationNmtcpp({
    files: { model: '/tmp/model.bin' },
    params: params || { srcLang: 'en', dstLang: 'it' },
    config: { modelType: TranslationNmtcpp.ModelTypes.Bergamot, ...config },
    opts: opts || {}
  })

  const calls = []
  model._createAddon = () => ({
    activate: async () => {},
    destroy: async () => {},
    cancel: async () => {},
    runJob: async (job) => {
      calls.push(job)
      return true
    },
    getActiveBackendName: () => 'CPU',
    getActiveBackendDescription: () => '',
    ...addonOverrides
  })

  const emitOutput = (data) => model._addonOutputCallback(null, 'Output', data, null)
  const emitStats = (stats) =>
    model._addonOutputCallback(null, 'JobEnded', stats || { TPS: 1, totalTime: 0.1 }, null)

  return { model, calls, emitOutput, emitStats }
}

test('run() serializes jobs through completion of the previous response', async (t) => {
  const { model, calls, emitOutput, emitStats } = makeModel()
  await model.load()

  const response1 = await model.run('first')
  let staleError = null
  response1.onError((err) => {
    staleError = err
  })

  let response2 = null
  const run2 = model.run('second').then((r) => {
    response2 = r
    return r
  })

  await tick()
  t.is(calls.length, 1, 'second job is not submitted while the first is in flight')
  t.is(response2, null, 'second response is not created yet')

  emitOutput('ciao')
  emitStats()
  await run2

  t.is(calls.length, 2, 'second job submitted after the first response settled')
  t.is(staleError, null, 'first response was never stale-replaced')

  emitOutput('mondo')
  emitStats()
  const result = await response2.await()
  t.alike(result, ['mondo'], 'second response delivers its own output')
})

test('runBatch() shares the exclusive queue with run()', async (t) => {
  const { model, calls, emitOutput, emitStats } = makeModel()
  await model.load()

  await model.run('single')

  let batchResult = null
  const batchPromise = model.runBatch(['one', 'two']).then((r) => {
    batchResult = r
    return r
  })

  await tick()
  t.is(calls.length, 1, 'batch waits for the in-flight run() to complete')

  emitOutput('uno')
  emitStats()
  await tick()

  t.is(calls.length, 2, 'batch submitted after run() settled')
  t.is(calls[1].type, 'sequences', 'batch uses the sequences job type')

  emitOutput(['uno', 'due'])
  emitStats()
  await batchPromise
  t.alike(batchResult, ['uno', 'due'], 'batch resolves with translations')
})

test('load() failure during activation destroys the addon and clears it', async (t) => {
  let destroyed = 0
  const { model } = makeModel({
    addonOverrides: {
      activate: async () => {
        throw new Error('activation boom')
      },
      destroy: async () => {
        destroyed++
      }
    }
  })

  let err = null
  try {
    await model.load()
  } catch (e) {
    err = e
  }

  t.is(err && err.message, 'activation boom', 'activation error propagates')
  t.is(destroyed, 1, 'failed addon instance was destroyed')
  t.is(model.addon, null, 'no addon handle is retained')
  t.alike(model.getState(), {
    configLoaded: false,
    weightsLoaded: false,
    destroyed: false
  })
  t.is(model.getActiveBackendName(), 'Unloaded')
})

test('load() sets weightsLoaded and unload() clears it', async (t) => {
  const { model } = makeModel()
  await model.load()
  t.alike(model.getState(), {
    configLoaded: true,
    weightsLoaded: true,
    destroyed: false
  })

  await model.unload()
  t.alike(model.getState(), {
    configLoaded: false,
    weightsLoaded: false,
    destroyed: false
  })
})

test('load() rejects after destroy()', async (t) => {
  const { model } = makeModel()
  await model.load()
  await model.destroy()
  t.is(model.getState().destroyed, true)

  let err = null
  try {
    await model.load()
  } catch (e) {
    err = e
  }
  t.ok(err, 'load() after destroy() rejects')
  t.ok(/destroyed/i.test(err.message), 'error explains the instance is destroyed')
})

test('run() rejects when the model is not loaded', async (t) => {
  const { model } = makeModel()

  let err = null
  try {
    await model.run('hello')
  } catch (e) {
    err = e
  }
  t.ok(err, 'run() before load() rejects')
  t.ok(/not loaded/i.test(err.message), 'error tells the caller to load() first')
})

test('en→pt runs prepend the >>por<< target token and strip it from output', async (t) => {
  const { model, calls, emitOutput, emitStats } = makeModel({
    params: { srcLang: 'en', dstLang: 'pt' }
  })
  await model.load()

  const response = await model.run('hello world')
  t.is(calls[0].input, '>>por<< hello world', 'input carries the target-language token')

  const updates = []
  response.onUpdate((data) => updates.push(data))
  emitOutput('>>por<< ola mundo')
  emitStats()
  await response.await()
  t.alike(updates, ['ola mundo'], 'echoed target token is stripped from output')

  const batchPromise = model.runBatch(['a', 'b'])
  await tick()
  t.alike(calls[1].input, ['>>por<< a', '>>por<< b'], 'batch inputs carry the token too')
  emitOutput(['>>por<< x', '>>por<< y'])
  emitStats()
  t.alike(await batchPromise, ['x', 'y'], 'batch output tokens are stripped')
})

test('other language pairs are not prefixed', async (t) => {
  const { model, calls, emitOutput, emitStats } = makeModel({
    params: { srcLang: 'en', dstLang: 'de' }
  })
  await model.load()

  await model.run('hello')
  t.is(calls[0].input, 'hello', 'no token for pairs without an entry')
  emitOutput('hallo')
  emitStats()
})

test('response.stats carries RuntimeStats when opts.stats is enabled', async (t) => {
  const { model, emitOutput, emitStats } = makeModel({ opts: { stats: true } })
  await model.load()

  const response = await model.run('hello')
  emitOutput('ciao')
  const stats = { totalTokens: 3, totalTime: 0.5, decodeTime: 0.4, TPS: 6 }
  emitStats(stats)
  await response.await()

  t.alike(response.stats, stats, 'stats object is exposed on the response')
})

test('package can be imported and errors are exposed without the native binding', (t) => {
  t.is(typeof TranslationNmtcpp, 'function', 'main export is the class')
  t.is(typeof TranslationNmtcpp.ModelTypes, 'object', 'ModelTypes is exposed')

  const { QvacErrorAddonMarian, ERR_CODES } = require('../../lib/error')
  t.is(typeof QvacErrorAddonMarian, 'function', 'QvacErrorAddonMarian is exported')
  t.ok(Object.isFrozen(ERR_CODES), 'ERR_CODES is frozen')
  for (const [name, code] of Object.entries(ERR_CODES)) {
    t.ok(code >= 8001 && code <= 9000, `${name} (${code}) is inside the allocated range`)
  }
})

test('main-gpu forwards registry indices and GPU classes to the native configuration', async (t) => {
  for (const key of ['main-gpu', 'main_gpu']) {
    for (const [value, expected] of [
      [0, 0],
      [2, 2],
      ['dedicated', 'dedicated'],
      ['integrated', 'integrated'],
      [-1, -1],
      ['2', 2],
      ['-1', -1],
      ['+1', 1],
      ['DEDICATED', 'dedicated']
    ]) {
      const { model } = makeModel({ config: { [key]: value, useGPU: true } })
      let received
      model._createAddon = ({ config }) => {
        received = config
        return { activate: async () => {}, destroy: async () => {} }
      }
      await model.load()
      t.is(received['main-gpu'], expected)
      t.is(received.main_gpu, undefined)
      t.is(received.use_gpu, true)
      await model.unload()
    }
  }
})

test('main-gpu rejects invalid and ambiguous selectors before native creation', async (t) => {
  const invalid = [
    null,
    true,
    false,
    -2147483649,
    0.5,
    NaN,
    Infinity,
    2147483648,
    '',
    '1.5',
    '2junk',
    '2147483648',
    'vulkan',
    {},
    []
  ].map((value) => ({ 'main-gpu': value }))
  invalid.push({ 'main-gpu': 0, main_gpu: 0 })
  for (const key of ['gpu_backend', 'gpuBackend', 'gpu_device', 'gpuDevice']) {
    invalid.push({ 'main-gpu': 0, [key]: key.includes('evice') ? 0 : 'vulkan' })
  }
  for (const config of invalid) {
    const { model } = makeModel({ config })
    model._createAddon = () => t.fail('invalid config must never reach native creation')
    let error
    try {
      await model.load()
    } catch (err) {
      error = err
    }
    t.ok(error instanceof TypeError)
    t.ok(/main-gpu/.test(error && error.message))
  }
})

test('legacy GPU aliases retain their original values without main-gpu', async (t) => {
  const { model } = makeModel({ config: { gpuBackend: 'vulkan', gpuDevice: 1 } })
  let received
  model._createAddon = ({ config }) => {
    received = config
    return { activate: async () => {}, destroy: async () => {} }
  }
  await model.load()
  t.is(received.gpu_backend, 'vulkan')
  t.is(received.gpu_device, 1)
  await model.unload()
})
