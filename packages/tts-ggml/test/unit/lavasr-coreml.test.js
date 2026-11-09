'use strict'

const test = require('brittle')
const TTSGgml = require('../../index.js')
const { TTSInterface } = require('../../tts.js')
const MockedBinding = require('../mock/MockedBinding.js')

const COMPUTE_UNITS = ['CPU_ONLY', 'CPU_AND_GPU', 'CPU_AND_NE', 'ALL']
const ENGINE_FILES = {
  chatterbox: { t3Model: '/models/t3.gguf', s3genModel: '/models/s3gen.gguf' },
  supertonic: { supertonicModel: '/models/supertonic.gguf' },
  parler: { parlerModel: '/models/parler.gguf' },
  cosyvoice3: { cosyvoiceModelDir: '/models/cosyvoice' }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

function stageOptions(stage, computeUnits) {
  return {
    type: 'lavasr',
    [`${stage}Path`]: `/models/${stage}.gguf`,
    coremlModelPath: `/models/${stage}.mlmodelc`,
    coremlComputeUnits: computeUnits
  }
}

function modelOptions(extra = {}, engine = 'supertonic') {
  return { engine, files: ENGINE_FILES[engine], ...extra }
}

function verifyPolicies(t, engine) {
  for (const units of COMPUTE_UNITS) {
    const model = new TTSGgml(
      modelOptions(
        {
          config: { useGPU: true },
          enhancer: stageOptions('enhancer', units),
          denoiser: stageOptions('denoiser', units)
        },
        engine
      )
    )
    const params = model._buildTtsParams()
    t.is(params.lavasrEnhancerPath, '/models/enhancer.gguf')
    t.is(params.lavasrDenoiserPath, '/models/denoiser.gguf')
    t.is(params.lavasrEnhancerCoremlModelPath, '/models/enhancer.mlmodelc')
    t.is(params.lavasrDenoiserCoremlModelPath, '/models/denoiser.mlmodelc')
    t.is(params.lavasrEnhancerCoremlComputeUnits, units)
    t.is(params.lavasrDenoiserCoremlComputeUnits, units)
    t.is(params.useGPU, true, 'the synthesis engine keeps its requested device')
  }
}

test('LavaSR Core ML reaches every supported engine with all four policies', (t) => {
  for (const engine of Object.keys(ENGINE_FILES)) verifyPolicies(t, engine)
})

test('LavaSR stages accept independent Core ML policies and GGUF file aliases', (t) => {
  const model = new TTSGgml(
    modelOptions({
      files: {
        ...ENGINE_FILES.supertonic,
        lavasrEnhancer: '/files/e.gguf',
        lavasrDenoiser: '/files/d.gguf'
      },
      enhancer: { ...stageOptions('enhancer', 'CPU_AND_NE'), enhancerPath: undefined },
      denoiser: { ...stageOptions('denoiser', 'CPU_AND_GPU'), denoiserPath: undefined }
    })
  )
  const params = model._buildTtsParams()
  t.is(params.lavasrEnhancerPath, '/files/e.gguf')
  t.is(params.lavasrDenoiserPath, '/files/d.gguf')
  t.is(params.lavasrEnhancerCoremlComputeUnits, 'CPU_AND_NE')
  t.is(params.lavasrDenoiserCoremlComputeUnits, 'CPU_AND_GPU')
})

function verifyInvalidOptions(t, stage) {
  const invalid = [
    { coremlModelPath: undefined },
    { coremlModelPath: '' },
    { coremlModelPath: '   ' },
    { coremlModelPath: 7 },
    { coremlComputeUnits: undefined },
    { coremlComputeUnits: null },
    { coremlComputeUnits: '' },
    { coremlComputeUnits: 'GPU_ONLY' },
    { coremlComputeUnits: 'cpu_and_ne' },
    { coremlComputeUnits: 7 }
  ]
  for (const value of invalid) {
    t.exception(
      () =>
        new TTSGgml(
          modelOptions({
            [stage]: { ...stageOptions(stage, 'CPU_AND_NE'), ...value }
          })
        ),
      /coremlModelPath|coremlComputeUnits/
    )
  }
  t.exception(
    () =>
      new TTSGgml(
        modelOptions({
          [stage]: { ...stageOptions(stage, 'CPU_AND_NE'), [`${stage}Path`]: undefined }
        })
      ),
    /requires the corresponding LavaSR GGUF path/
  )
}

test('LavaSR rejects partial and invalid Core ML options instead of using another backend', (t) => {
  verifyInvalidOptions(t, 'enhancer')
  verifyInvalidOptions(t, 'denoiser')
})

test('LavaSR keeps the native backend configuration when Core ML is absent', (t) => {
  const model = new TTSGgml(
    modelOptions({
      enhancer: { type: 'lavasr', enhancerPath: '/models/e.gguf' },
      denoiser: { type: 'lavasr', denoiserPath: '/models/d.gguf' }
    })
  )
  const params = model._buildTtsParams()
  t.is(params.lavasrEnhancerPath, '/models/e.gguf')
  t.is(params.lavasrDenoiserPath, '/models/d.gguf')
  t.absent('lavasrEnhancerCoremlModelPath' in params)
  t.absent('lavasrEnhancerCoremlComputeUnits' in params)
  t.absent('lavasrDenoiserCoremlModelPath' in params)
  t.absent('lavasrDenoiserCoremlComputeUnits' in params)
})

test('LavaSR Core ML preserves the existing denoiser streaming restriction', (t) => {
  t.exception(
    () =>
      new TTSGgml(
        modelOptions({
          streamChunkTokens: 10,
          denoiser: stageOptions('denoiser', 'CPU_AND_NE')
        })
      ),
    /streaming|Streaming/
  )
})

test('a failed Core ML reload destroys the partial addon and cannot accept jobs', async (t) => {
  const model = new TTSGgml(
    modelOptions({
      enhancer: stageOptions('enhancer', 'CPU_AND_NE')
    })
  )
  let created = 0
  let destroyed = 0
  let jobs = 0
  model._createAddon = (configuration, callback) => {
    const binding = new MockedBinding()
    const destroy = binding.destroyInstance.bind(binding)
    binding.destroyInstance = (handle) => {
      destroyed++
      return destroy(handle)
    }
    binding.runJob = () => {
      jobs++
      return true
    }
    if (++created > 1) {
      binding.activate = () => {
        throw new Error('Cannot load explicitly selected Core ML model')
      }
    }
    return new TTSInterface(binding, configuration, callback)
  }
  await model.load()
  await t.exception(model.reload(), /Cannot load explicitly selected Core ML model/)
  t.absent(model.addon, 'the failed native addon is no longer reachable')
  t.is(destroyed, 2, 'the original addon and failed replacement were destroyed')
  await t.exception(async () => {
    const response = await model.run({ input: 'This must fail.' })
    await response.await()
  }, /not loaded|Core ML model/)
  t.is(jobs, 0, 'no synthesis can bypass the explicitly selected stage')
})

test('a failed older Core ML reload preserves the newer active addon', async (t) => {
  const model = new TTSGgml(modelOptions({ enhancer: stageOptions('enhancer', 'CPU_AND_NE') }))
  const first = { started: deferred(), activation: deferred() }
  const second = { started: deferred(), activation: deferred() }
  const activations = [undefined, first, second]
  const instances = []
  const destroyed = new Set()
  t.teardown(async () => {
    first.activation.resolve()
    second.activation.resolve()
    await Promise.all(instances.map((addon) => addon.destroyInstance()))
  })
  model._createAddon = (configuration, callback) => {
    const binding = new MockedBinding()
    const pending = activations[instances.length]
    const activate = binding.activate.bind(binding)
    if (pending) {
      binding.activate = async (handle) => {
        pending.started.resolve()
        await pending.activation.promise
        activate(handle)
      }
    }
    const addon = new TTSInterface(binding, configuration, callback)
    const destroy = addon.destroyInstance.bind(addon)
    addon.destroyInstance = async () => {
      await destroy()
      destroyed.add(addon)
    }
    instances.push(addon)
    return addon
  }
  await model.load()
  const firstReload = t.exception(model.reload(), /First Core ML activation failed/)
  await first.started.promise
  const secondReload = model.reload()
  await second.started.promise
  const newest = model.addon
  second.activation.resolve()
  await secondReload
  t.is(model.addon, newest, 'the newer reload activates its replacement')
  first.activation.reject(new Error('First Core ML activation failed'))
  await firstReload
  t.is(model.addon, newest, 'the older failure cannot clear the active replacement')
  t.absent(destroyed.has(newest), 'the active replacement remains alive')
  let samples = 0
  const response = await model.run({ input: 'The newer model still works.' })
  await response
    .onUpdate((chunk) => {
      if (chunk.outputArray) samples += chunk.outputArray.length
    })
    .await()
  t.ok(samples > 0, 'synthesis still produces audio through the newer instance')
  await model.unload()
  t.ok(destroyed.has(newest), 'unload can still reach and destroy the active replacement')
  t.absent(model.addon, 'unload clears the replacement')
})
