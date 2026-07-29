'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const process = require('bare-process')
const { fitParams, FIT_STATUS } = require('../../index.js')
const { ensureModelPath } = require('./utils')

test('fitParams rejects invalid config', async function (t) {
  await t.exception.all(() => fitParams(), /config object is required/)
  await t.exception.all(() => fitParams(null), /config object is required/)
  await t.exception.all(() => fitParams({}), /modelPath must be a non-empty string/)
  await t.exception.all(() => fitParams({ modelPath: '' }), /modelPath must be a non-empty string/)
  await t.exception.all(() => fitParams({ modelPath: '/x.gguf', nCtx: 'big' }), /nCtx must be a finite number/)
})

test('FIT_STATUS enum matches llama_params_fit_status', function (t) {
  t.is(FIT_STATUS.SUCCESS, 0)
  t.is(FIT_STATUS.FAILURE, 1)
  t.is(FIT_STATUS.ERROR, 2)
})

test('fitParams on a real GGUF projects a load plan', async function (t) {
  // Use a caller-supplied model when provided (local runs against a real
  // model), otherwise download the tiny public GGUF so CI exercises the real
  // projection path on every platform.
  const modelPath = process.env.FIT_MODEL_PATH || await ensureModelPath()
  t.ok(fs.existsSync(modelPath), `model exists at ${modelPath}`)

  const res = fitParams({ modelPath, nCtx: 4096, nCtxMin: 512, marginMiB: 1024 })

  t.ok([FIT_STATUS.SUCCESS, FIT_STATUS.FAILURE, FIT_STATUS.ERROR].includes(res.status), 'status is a known code')
  t.is(typeof res.fits, 'boolean')
  t.is(typeof res.nGpuLayers, 'number')
  t.is(typeof res.nCtx, 'number')
  t.ok(Array.isArray(res.tensorSplit), 'tensorSplit is an array')
  t.is(res.tensorSplit.length, res.maxDevices, 'tensorSplit has one entry per device')

  // maxDevices is llama_max_devices(), a build-time bound, so it proves nothing
  // about detection. nDevices is the real inventory: backends registered, the
  // fitter had a machine to measure, and the projection means something.
  t.ok(res.nDevices >= 1, 'at least one backend device was actually registered')
  t.ok(res.nDevices <= res.maxDevices, 'detected devices within addressable bound')
  t.ok(res.nGpuDevices <= res.nDevices, 'accelerator count is a subset of all devices')
  t.not(res.status, FIT_STATUS.ERROR, 'a registered device must not yield ERROR on a readable model')

  if (res.fits) {
    t.ok(res.nCtx >= 512 && res.nCtx <= 4096, 'fitted context within [nCtxMin, requested]')
  }
})

test('fitParams reports the device inventory it fitted against', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || await ensureModelPath()
  const res = fitParams({ modelPath, nCtx: 4096, nCtxMin: 512, marginMiB: 1024 })

  // Guards the regression this addon shipped with: no backend registration at
  // all, which returns a confident verdict measured against an empty device
  // list. Zero devices is now ERROR, never SUCCESS.
  t.ok(res.nDevices > 0 || res.status === FIT_STATUS.ERROR, 'zero devices can only ever report ERROR')

  if (res.nGpuDevices === 0) {
    t.is(res.nGpuLayers, 0, 'host-only projection offloads no layers')
  }
})

test('fitParams rejects a non-string backendsDir', async function (t) {
  await t.exception.all(
    () => fitParams({ modelPath: '/x.gguf', backendsDir: 42 }),
    /backendsDir must be a non-empty string/
  )
  await t.exception.all(
    () => fitParams({ modelPath: '/x.gguf', backendsDir: '' }),
    /backendsDir must be a non-empty string/
  )
})

test('fitParams on a missing file reports ERROR (does not throw)', function (t) {
  const res = fitParams({ modelPath: '/nonexistent/does-not-exist.gguf' })
  t.is(res.status, FIT_STATUS.ERROR, 'missing model yields ERROR status')
  t.is(res.fits, false)
})
