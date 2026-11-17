'use strict'

const test = require('brittle')
const { AudioGen, audiogenBackendName } = require('../../index.js')

function acestep(config = {}) {
  return new AudioGen({ files: { modelDir: '/models/acestep' }, config })
}

function minimax(config = {}) {
  return new AudioGen({ engine: 'minimax', files: { modelDir: '/models/minimax' }, config })
}

test('ACE-Step forwards independent backends and an explicit dump directory', async (t) => {
  const config = { backend: 'CPU', lmBackend: 'WebGPU', dumpStagesDir: '/existing/stages' }
  const gen = acestep(config)
  let received
  gen._createAddon = (configuration) => {
    received = configuration
    return {
      activate: () => Promise.resolve(),
      destroyInstance: () => Promise.resolve()
    }
  }
  t.teardown(() => gen.destroy())
  await gen.load()
  t.is(received.backend, 'CPU')
  t.is(received.lmBackend, 'WebGPU')
  t.is(received.dumpStagesDir, '/existing/stages')
  t.is(received.useGPU, false, 'explicit backends retain the existing legacy flag')
})

test('unset and native auto selectors preserve existing configuration', (t) => {
  const implicit = acestep()._configuration
  t.is(implicit.backend, undefined)
  t.is(implicit.lmBackend, undefined)
  t.is(implicit.dumpStagesDir, undefined)
  const explicit = acestep({ backend: 'auto', lmBackend: '', dumpStagesDir: '' })._configuration
  t.is(explicit.backend, 'auto')
  t.is(explicit.lmBackend, '')
  t.is(explicit.dumpStagesDir, '')
})

test('MiniMax forwards a Core ML conditioner without replacing the rest of the pipeline', (t) => {
  const configuration = minimax({
    coremlConditionerPath: '/models/conditioner.mlmodelc',
    device: 'gpu'
  })._configuration
  t.is(configuration.coremlConditionerPath, '/models/conditioner.mlmodelc')
  t.is(configuration.device, 'gpu')
  t.is(configuration.coremlProfileDir, undefined)
  t.is(configuration.coremlComputeUnits, undefined)
  t.is(minimax()._configuration.coremlConditionerPath, undefined)
})

test('runtime strings reject type errors and embedded NULs before native loading', (t) => {
  for (const key of ['backend', 'lmBackend', 'dumpStagesDir']) {
    for (const value of [null, false, 1, {}, 'prefix\0suffix']) {
      t.exception(() => acestep({ [key]: value }), new RegExp(`${key} must be a string`))
    }
  }
  for (const value of [null, false, 1, {}, '/models/\0conditioner']) {
    t.exception(
      () => minimax({ coremlConditionerPath: value }),
      /coremlConditionerPath must be a string/
    )
  }
})

test('runtime controls reject the wrong engine', (t) => {
  for (const config of [{ backend: 'CPU' }, { lmBackend: 'CPU' }, { dumpStagesDir: '/tmp' }]) {
    t.exception(() => minimax(config), /MiniMax does not accept backend/)
  }
  t.exception(
    () => acestep({ coremlConditionerPath: '/models/conditioner.mlmodelc' }),
    /MiniMax-only options/
  )
})

test('WebGPU has the same stable public backend ID as sibling addons', (t) => {
  t.is(audiogenBackendName(5), 'webgpu')
  t.is(audiogenBackendName(4), 'opencl')
  t.is(audiogenBackendName(99), 'other')
})
