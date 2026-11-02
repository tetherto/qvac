'use strict'

const test = require('brittle')
const { ModelInterface, ModelRunner } = require('../../modelRunner.js')

// The lifecycle LayaDecisions and Reranker share, driven through a fake
// binding: no model and no native addon.

const MODEL = '/models/test.gguf'

function fakeBinding({ accept = true, activateError = null } = {}) {
  const binding = {
    calls: [],
    outputCb: null,
    createTestInstance(owner, params, outputCb) {
      binding.calls.push('create')
      binding.owner = owner
      binding.params = params
      binding.outputCb = outputCb
      return { handle: true }
    },
    activate() {
      binding.calls.push('activate')
      return activateError ? Promise.reject(activateError) : Promise.resolve()
    },
    loadWeights() {
      binding.calls.push('loadWeights')
      return Promise.resolve()
    },
    cancel() {
      binding.calls.push('cancel')
      return Promise.resolve()
    },
    destroyInstance() {
      binding.calls.push('destroy')
    },
    runJob(handle, input) {
      binding.calls.push(`runJob:${input}`)
      return Promise.resolve(accept)
    },
    // Native events arrive through the output callback.
    emit(event, data, error) {
      binding.outputCb(null, event, data, error)
    }
  }
  return binding
}

class TestInterface extends ModelInterface {
  _createInstance(params, outputCb) {
    return this._binding.createTestInstance(this, params, outputCb)
  }

  runJob(input) {
    return this._binding.runJob(this._handle, input)
  }
}

class TestRunner extends ModelRunner {
  constructor(args, binding) {
    super(args)
    this._modelName = 'Test'
    this._fake = binding
    this.encoded = []
  }

  _loadBinding() {
    return this._fake
  }

  _createAddon(binding, params, outputCb) {
    return new TestInterface(binding, params, outputCb)
  }

  _encodeRequest(request) {
    if (request === 'unencodable') throw new TypeError('cannot encode')
    this.encoded.push(request)
    return `encoded:${request}`
  }

  _startJob(addon, payload) {
    return addon.runJob(payload)
  }

  _mapEvent(event, data, error) {
    if (event === 'Output') return { type: 'Output', data, error: null }
    if (event === 'Error') return { type: 'Error', data, error }
    if (event === 'Stats') return { type: 'JobEnded', data, error: null }
    if (event === 'Malformed') throw new Error('malformed output')
    return null
  }

  run(request) {
    return this._runRequest(request)
  }
}

async function loaded(opts = {}, bindingOpts = {}) {
  const binding = fakeBinding(bindingOpts)
  const runner = new TestRunner(
    { files: { model: [MODEL] }, config: { device: 'cpu' }, opts },
    binding
  )
  await runner.load()
  return { runner, binding }
}

test('constructor rejects missing or relative model paths', function (t) {
  t.exception.all(() => new TestRunner({ files: { model: [] }, config: {} }), /non-empty array/)
  t.exception.all(
    () => new TestRunner({ files: { model: ['model.gguf'] }, config: {} }),
    /must be an absolute path/
  )
})

test('load creates and activates the instance once', async function (t) {
  const { runner, binding } = await loaded()
  await runner.load()
  t.alike(binding.calls, ['create', 'activate'])
  t.is(binding.owner instanceof TestInterface, true, 'the interface owns the instance')
  t.is(binding.params.path, MODEL)
  t.is(
    binding.params.backendsDir,
    '',
    'an unset backends dir is left for the native side to resolve'
  )
  t.alike(runner.getState(), { configLoaded: true })
})

test('a failed load releases the instance and leaves the runner unloaded', async function (t) {
  const binding = fakeBinding({ activateError: new Error('no backend') })
  const runner = new TestRunner({ files: { model: [MODEL] }, config: {} }, binding)
  await t.exception(runner.load(), /no backend/)
  t.alike(binding.calls, ['create', 'activate', 'destroy'])
  t.alike(runner.getState(), { configLoaded: false })
  await t.exception(runner.run('q'), /Call load\(\) first/)
})

test('outputs resolve the response, with stats only when asked', async function (t) {
  for (const stats of [true, false]) {
    const { runner, binding } = await loaded({ stats })
    const response = await runner.run('q')
    t.ok(binding.calls.includes('runJob:encoded:q'), 'the encoded request reaches the binding')
    binding.emit('Output', [1, 2])
    binding.emit('Stats', { documents: 2 })
    t.alike(await response.await(), [[1, 2]])
    if (stats) {
      t.alike(response.stats, { documents: 2 })
    } else {
      t.absent(response.stats && response.stats.documents, 'no stats without opts.stats')
    }
  }
})

test('a second request while one runs is refused', async function (t) {
  const { runner, binding } = await loaded()
  const first = await runner.run('a')
  await t.exception(runner.run('b'), /a job is already set or being processed/)
  binding.emit('Output', 'done')
  binding.emit('Stats', {})
  t.alike(await first.await(), ['done'])
  const next = await runner.run('c')
  binding.emit('Stats', {})
  await next.await()
  t.pass('a new request runs once the first settles')
})

test('a refused job fails as busy', async function (t) {
  const { runner } = await loaded({}, { accept: false })
  await t.exception(runner.run('q'), /a job is already set or being processed/)
})

test('a request that cannot be encoded starts no job', async function (t) {
  const { runner, binding } = await loaded()
  await t.exception.all(runner.run('unencodable'), /cannot encode/)
  t.absent(
    binding.calls.some((call) => call.startsWith('runJob')),
    'nothing reached the binding'
  )
  const response = await runner.run('ok')
  binding.emit('Stats', {})
  await response.await()
  t.pass('the runner is not left busy')
})

test('Error events and malformed output fail the job', async function (t) {
  const { runner, binding } = await loaded()
  const failed = await runner.run('a')
  binding.emit('Error', undefined, new Error('decode failed'))
  await t.exception(failed.await(), /decode failed/)

  const malformed = await runner.run('b')
  binding.emit('Malformed', null)
  await t.exception(malformed.await(), /malformed output/)
})

test('unload cancels, fails the running job and releases the instance', async function (t) {
  const { runner, binding } = await loaded()
  const response = await runner.run('q')
  await runner.unload()
  await t.exception(response.await(), /Model was unloaded/)
  t.ok(binding.calls.includes('cancel'))
  t.is(binding.calls.at(-1), 'destroy')
  t.alike(runner.getState(), { configLoaded: false })
  await t.exception(runner.run('q'), /Call load\(\) first/)
})
