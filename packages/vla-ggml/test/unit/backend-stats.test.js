'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')

// Evaluate the emitted wrapper with only its native binding replaced. Keep the
// real job handler and response so these tests exercise public run results.
function createModel(backendName, stats = false) {
  const instances = []
  const binding = {
    setLogger() {},
    setVerbosity() {},
    releaseLogger() {},
    activate() {},
    createInstance(owner, config, callback) {
      const instance = { owner, callback }
      instances.push(instance)
      return instance
    },
    getVlaHparams: () => null,
    getVlaBackendName: () => backendName,
    runJob: () => true,
    cancel: () => Promise.resolve(),
    destroyInstance() {}
  }
  const root = path.resolve(__dirname, '../..')
  const module = { exports: {} }
  const load = (name) => {
    if (name === './binding') return binding
    return require(name.startsWith('.') ? path.join(root, name) : name)
  }
  const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
  Function('require', 'module', 'exports', source)(load, module, module.exports)
  const model = new module.exports({
    files: { model: [path.join(root, 'index.js')] },
    opts: { stats }
  })
  return { model, instances }
}

function emit(instance, event, output, error) {
  instance.callback(instance.owner, event, output, error)
}

const input = {
  images: [new Float32Array(3)],
  imgWidth: 1,
  imgHeight: 1,
  state: new Float32Array(1),
  tokens: new Int32Array(1),
  mask: new Uint8Array(1)
}

test('run stats report backend families and preserve native device labels', async (t) => {
  const cases = [
    ['CPU', 'cpu'],
    ['CUDA0', 'cuda'],
    ['CUDA1', 'cuda'],
    ['MTL0', 'metal'],
    ['Metal', 'metal'],
    ['Vulkan0', 'vulkan'],
    ['GPUOpenCL', 'opencl'],
    ['ROCm0', 'rocm'],
    ['SYCL0', 'sycl']
  ]
  for (const [device, family] of cases) {
    for (const enabled of [false, true]) {
      const { model, instances } = createModel(device, enabled)
      try {
        await model.load()
        const response = await model.run(input)
        const updates = []
        response.on('stats', (value) => updates.push(value))
        const actions = new Float32Array([1, 2])
        const nativeStats = { total_ms: 5, backendDevice: family === 'cpu' ? 0 : 1 }
        emit(instances[0], 'Output', actions)
        emit(instances[0], 'JobEnded', nativeStats)
        const result = await response.await()
        t.is(model.backendName, device, 'native device label is unchanged')
        t.is(result.actions, actions)
        t.alike(result.stats, { ...nativeStats, backendName: family })
        t.absent('backendName' in nativeStats, 'native stats are unchanged')
        t.alike(updates, enabled ? [result.stats] : [], 'stats events follow opts.stats')
      } finally {
        await model.unload()
      }
    }
  }
})

test('callbacks from an unloaded instance cannot complete a new run', async (t) => {
  const { model, instances } = createModel('MTL0', true)
  try {
    await model.load()
    const old = instances[0]
    await model.unload()
    await model.load()
    const response = await model.run(input)
    const updates = []
    response.on('stats', (value) => updates.push(value))
    const actions = new Float32Array([1])
    emit(instances[1], 'Output', actions)
    emit(old, 'Output', new Float32Array([99]))
    emit(old, 'JobEnded', { total_ms: 99 })
    emit(old, 'Error', null, 'stale error')
    t.alike(updates, [], 'old stats are dropped')
    emit(instances[1], 'JobEnded', { total_ms: 1 })
    const result = await response.await()
    t.is(result.actions, actions, 'only current actions reach the response')
    t.is(result.stats.total_ms, 1, 'only current timings reach the response')
    t.is(result.stats.backendName, 'metal')
    t.alike(updates, [result.stats], 'only current stats reach listeners')
  } finally {
    await model.unload()
  }
})
