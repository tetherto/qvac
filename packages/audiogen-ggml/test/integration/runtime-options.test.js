'use strict'

const test = require('brittle')
const os = require('bare-os')
const { AudioGenInterface } = require('../../audiogen.js')
const { assessFit } = require('../../index.js')
const binding = require('../../binding.js')

const mobile = os.platform() === 'android' || os.platform() === 'ios'

function createAddon(engineType, options) {
  return new AudioGenInterface(
    binding,
    {
      engineType,
      modelDir: '/models/not-loaded',
      inferenceSteps: 0,
      shift: 0,
      threads: 0,
      useGPU: false,
      nGpuLayers: 0,
      ...options
    },
    () => {}
  )
}

test('native ACE-Step parsing rejects malformed backend and dump strings', (t) => {
  for (const key of ['backend', 'lmBackend', 'dumpStagesDir']) {
    for (const value of [false, null, 42, 'prefix\0suffix']) {
      t.exception(() => createAddon('acestep', { [key]: value }), new RegExp(key))
    }
  }
})

test('native MiniMax parsing rejects a malformed conditioner path', { skip: mobile }, (t) => {
  for (const value of [false, null, 42, '/models/\0conditioner']) {
    t.exception(
      () => createAddon('minimax', { coremlConditionerPath: value }),
      /coremlConditionerPath/
    )
  }
})

test('preflight rejects malformed backend strings before running a fit', async (t) => {
  for (const key of ['backend', 'lmBackend']) {
    for (const value of [false, null, 42, 'prefix\0suffix']) {
      await t.exception(() => assessFit({ [key]: value }), new RegExp(key))
    }
  }
})

test('MiniMax conditioner preflight remains explicitly unsized', { skip: mobile }, async (t) => {
  const fit = await assessFit({
    engine: 'minimax',
    coremlConditionerPath: '/models/conditioner.mlmodelc',
    device: 'cpu'
  })
  t.is(fit.status, 'unknown')
  t.alike(fit.devices, [])
  t.alike(fit.stats, {})
  await t.exception(
    () => assessFit({ engine: 'minimax', coremlConditionerPath: '/models/\0conditioner' }),
    /coremlConditionerPath/
  )
})
