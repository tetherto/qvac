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
  t.ok(res.maxDevices >= 1, 'reports at least one device')
  t.ok(Array.isArray(res.tensorSplit), 'tensorSplit is an array')
  t.is(res.tensorSplit.length, res.maxDevices, 'tensorSplit has one entry per device')

  if (res.fits) {
    t.ok(res.nCtx >= 512 && res.nCtx <= 4096, 'fitted context within [nCtxMin, requested]')
  }
})

test('fitParams on a missing file reports ERROR (does not throw)', function (t) {
  const res = fitParams({ modelPath: '/nonexistent/does-not-exist.gguf' })
  t.is(res.status, FIT_STATUS.ERROR, 'missing model yields ERROR status')
  t.is(res.fits, false)
})
