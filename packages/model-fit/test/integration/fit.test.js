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
  await t.exception.all(() => fitParams({ modelPath: '/x.gguf', nCtx: 'big' }), /nCtx must be a safe integer/)
})

test('fitParams rejects values that would truncate or wrap in the binding', async function (t) {
  const base = { modelPath: '/x.gguf' }

  // Fractions truncate on the way to uint32_t/int32_t.
  await t.exception.all(() => fitParams({ ...base, nCtx: 4096.5 }), /nCtx must be a safe integer/)
  await t.exception.all(() => fitParams({ ...base, marginMiB: 0.5 }), /marginMiB must be a safe integer/)
  await t.exception.all(() => fitParams({ ...base, nCtx: NaN }), /nCtx must be a safe integer/)
  await t.exception.all(() => fitParams({ ...base, nCtx: Infinity }), /nCtx must be a safe integer/)

  // Negatives wrap: marginMiB -1 would become a margin nothing can satisfy.
  await t.exception.all(() => fitParams({ ...base, marginMiB: -1 }), /marginMiB must be between/)
  await t.exception.all(() => fitParams({ ...base, nGpuLayers: -1 }), /nGpuLayers must be between/)

  // Above the width of the target integer type.
  await t.exception.all(() => fitParams({ ...base, nCtx: 4294967296 }), /nCtx must be between/)
  await t.exception.all(() => fitParams({ ...base, nGpuLayers: 2147483648 }), /nGpuLayers must be between/)

  // Relationships the fitter would otherwise reinterpret or reject obscurely.
  await t.exception.all(() => fitParams({ ...base, nBatch: 256, nUbatch: 512 }), /nUbatch must not exceed/)
  await t.exception.all(() => fitParams({ ...base, nCtx: 512, nCtxMin: 1024 }), /nCtxMin must not exceed/)
})

test('binding.paramsFit enforces the same constraints as the wrapper', async function (t) {
  // ./binding.js is a public export, so these checks cannot live only in the
  // JS wrapper — a caller can reach the native entry point directly.
  const binding = require('../../binding.js')

  await t.exception.all(() => binding.paramsFit({ modelPath: '/x.gguf', marginMiB: -1 }), /out of range/)
  await t.exception.all(() => binding.paramsFit({ modelPath: '/x.gguf', nCtx: 4096.5 }), /must be an integer/)
  await t.exception.all(() => binding.paramsFit({ modelPath: '/x.gguf', nBatch: 256, nUbatch: 512 }), /must not exceed/)
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
    // The README defines an explicit nCtx as a hard constraint, not a hint:
    // llama only reduces the context when it is 0.
    t.is(res.nCtx, 4096, 'an explicitly requested context is returned unchanged')
  }
})

test('a successful plan always carries a concrete context', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || await ensureModelPath()

  // nCtx: 0 lets the fitter choose. llama encodes "use the trained context" as
  // 0, so without resolution a SUCCESS could hand back nCtx: 0 — not a plan any
  // caller can act on.
  const res = fitParams({ modelPath, nCtx: 0, marginMiB: 1024 })

  if (res.fits) {
    t.ok(res.nCtx > 0, 'a fitted plan never reports a context of zero')
  } else {
    t.pass(`model did not fit on this runner (status ${res.status}); context resolution not exercised`)
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
