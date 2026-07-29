'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const process = require('bare-process')
const { fitParams, FIT_STATUS } = require('../../index.js')
const { ensureModelPath } = require('./utils')

// Deliberately never created. Argument validation must reject configs using it
// before any file is opened, so these cases never reach the fitter.
const UNREACHABLE_MODEL = '/model-fit-validation-only/never-created.gguf'

test('fitParams rejects invalid config', async function (t) {
  await t.exception.all(() => fitParams(), /config object is required/)
  await t.exception.all(() => fitParams(null), /config object is required/)
  await t.exception.all(() => fitParams({}), /modelPath must be a non-empty string/)
  await t.exception.all(() => fitParams({ modelPath: '' }), /modelPath must be a non-empty string/)
  await t.exception.all(() => fitParams({ modelPath: UNREACHABLE_MODEL, nCtx: 'big' }), /nCtx must be a safe integer/)
})

test('fitParams rejects values that would truncate or wrap in the binding', async function (t) {
  const base = { modelPath: UNREACHABLE_MODEL }

  // Fractions truncate on the way to uint32_t/int32_t.
  await t.exception.all(() => fitParams({ ...base, nCtx: 4096.5 }), /nCtx must be a safe integer/)
  await t.exception.all(() => fitParams({ ...base, marginMiB: 0.5 }), /marginMiB must be a safe integer/)
  await t.exception.all(() => fitParams({ ...base, nCtx: NaN }), /nCtx must be a safe integer/)
  await t.exception.all(() => fitParams({ ...base, nCtx: Infinity }), /nCtx must be a safe integer/)

  // Negatives wrap on unsigned fields: marginMiB -1 would become a margin
  // nothing can satisfy. nGpuLayers is exempt — see the next test.
  await t.exception.all(() => fitParams({ ...base, marginMiB: -1 }), /marginMiB must be between/)
  await t.exception.all(() => fitParams({ ...base, nCtxMin: -1 }), /nCtxMin must be between/)

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

  await t.exception.all(() => binding.paramsFit({ modelPath: UNREACHABLE_MODEL, marginMiB: -1 }), /out of range/)
  await t.exception.all(() => binding.paramsFit({ modelPath: UNREACHABLE_MODEL, nCtx: 4096.5 }), /must be an integer/)
  await t.exception.all(() => binding.paramsFit({ modelPath: UNREACHABLE_MODEL, nBatch: 256, nUbatch: 512 }), /must not exceed/)
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

  // 2048 is what stories260K declares as its context length; asking for more is
  // now rejected outright, so this is the largest concrete request it accepts.
  const res = fitParams({ modelPath, nCtx: 2048, nCtxMin: 512, marginMiB: 1024 })

  t.ok([FIT_STATUS.SUCCESS, FIT_STATUS.FAILURE, FIT_STATUS.ERROR].includes(res.status), 'status is a known code')
  t.is(typeof res.fits, 'boolean')
  t.is(typeof res.nGpuLayers, 'number')
  t.is(typeof res.nCtx, 'number')
  t.ok(Array.isArray(res.tensorSplit), 'tensorSplit is an array')
  t.is(res.tensorSplit.length, res.maxDevices, 'tensorSplit has one entry per device')

  // maxDevices is llama_max_devices(), a build-time bound, so it proves nothing
  // about detection. nDevices is the real inventory: backends registered, the
  // fitter had a machine to measure, and the projection means something.
  t.ok(Array.isArray(res.buftOverrides), 'placement the projection depended on is reported')
  t.ok(['fits', 'does-not-fit', 'model-unreadable', 'no-backend-device'].includes(res.reason), 'reason is a known code')
  t.ok(res.nDevices >= 1, 'at least one backend device was actually registered')
  t.ok(res.nDevices <= res.maxDevices, 'detected devices within addressable bound')
  t.ok(res.nGpuDevices <= res.nDevices, 'accelerator count is a subset of all devices')
  t.not(res.status, FIT_STATUS.ERROR, 'a registered device must not yield ERROR on a readable model')

  if (res.fits) {
    t.ok(res.nCtx >= 512 && res.nCtx <= 2048, 'fitted context within [nCtxMin, requested]')
    // The README defines an explicit nCtx as a hard constraint, not a hint:
    // llama only reduces the context when it is 0.
    t.is(res.nCtx, 2048, 'an explicitly requested context is returned unchanged')
  }
})

test('a context beyond what the model declares is rejected', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || await ensureModelPath()

  // This addon exposes no RoPE scaling knobs, so the only extension reachable
  // through it is the model's own — and a YaRN-extended model already reports
  // the extended figure as context_length. Anything past it is nonsense input,
  // and rejecting it also keeps the absurd values that abort the fitter out of
  // llama's hands entirely.
  await t.exception.all(
    () => fitParams({ modelPath, nCtx: 100000000 }),
    /exceeds the context length the model declares/
  )
  await t.exception.all(
    () => fitParams({ modelPath, nCtx: 2049 }),
    /exceeds the context length the model declares/
  )

  // The declared length itself must still be accepted.
  const res = fitParams({ modelPath, nCtx: 2048 })
  t.not(res.status, FIT_STATUS.ERROR, 'the declared context length is allowed')
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

test('a negative nGpuLayers is valid input meaning "all layers"', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || await ensureModelPath()

  // llama.h: "number of layers to store in VRAM, a negative value means all
  // layers". It is the llama default, and what upstream's own fit-params prints
  // back (`-ngl -1`), so it must not be rejected as out of range.
  const res = fitParams({ modelPath, nGpuLayers: -1, marginMiB: 1024 })

  t.ok([FIT_STATUS.SUCCESS, FIT_STATUS.FAILURE, FIT_STATUS.ERROR].includes(res.status), 'accepted, not rejected')

  // Deliberately not asserting the value comes back as -1. The fitter only
  // rewrites fields still holding their llama default, and -1 *is* the default
  // for n_gpu_layers — so passing it is indistinguishable from passing nothing
  // and the fitter stays free to choose. Pinning requires a non-default value.
  t.is(typeof res.nGpuLayers, 'number', 'a plan is still returned')
})

test('a non-default nGpuLayers is what actually pins the offload', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || await ensureModelPath()

  // 0 is non-default, so unlike -1 it is a real constraint the fitter honours.
  const res = fitParams({ modelPath, nGpuLayers: 0, marginMiB: 1024 })

  t.is(res.nGpuLayers, 0, 'a non-default pin is preserved')
})

test('memory pressure moves the plan off the GPU rather than reporting FAILURE', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || await ensureModelPath()

  // `llama_params_fit` fits to free *device* memory and, per llama.h, "assumes
  // system memory is unlimited". So an unmeetable device margin is satisfied by
  // moving every layer to the host and shrinking the context — not by returning
  // FAILURE. Driving this with the margin rather than with a large model keeps
  // it deterministic: a model sized to overflow one CI runner's VRAM fits the
  // next one, whereas no device can honour a multi-TiB margin.
  //
  // This is the load-bearing behaviour for anything gating admission: `fits`
  // stays true under extreme pressure, so the plan is the signal, not the flag.
  const res = fitParams({ modelPath, nCtx: 0, marginMiB: 10000000 })

  t.is(res.status, FIT_STATUS.SUCCESS, 'host fallback is still reported as a fit')
  t.is(res.fits, true)
  t.ok(res.nCtx > 0, 'a fitted plan still carries a concrete context')
  t.ok(res.nCtx <= 2048, 'context was reduced, not left at the trained maximum')

  // Only meaningful where there is a GPU to move layers off. On a CPU-only
  // runner the fitter has no offload decision to make, so it leaves
  // n_gpu_layers at the llama default — which is negative, meaning "all
  // layers", not zero.
  if (res.nGpuDevices > 0) {
    t.is(res.nGpuLayers, 0, 'an unsatisfiable device margin offloads nothing to GPU')
  } else {
    t.pass('no accelerator present; offload count is not a meaningful assertion')
  }
})

test('pinned offload under pressure is the only way to get FAILURE', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || await ensureModelPath()

  // Unpinned, the fitter always has the host to fall back on, so it answers an
  // unmeetable margin with SUCCESS and zero offload (see the test above).
  // Pinning nGpuLayers makes offload a hard constraint it cannot relax, so the
  // margin can no longer be escaped and the verdict is a real FAILURE.
  //
  // This is the shape of a meaningful admission question: not "can this run at
  // all" — on CPU it essentially always can — but "can this run with at least N
  // layers on the GPU".
  const res = fitParams({ modelPath, nGpuLayers: 5, marginMiB: 10000000 })

  t.is(res.nGpuLayers, 5, 'the pinned layer count is preserved, not reduced')

  if (res.nGpuDevices > 0) {
    t.is(res.status, FIT_STATUS.FAILURE, 'a pinned plan that cannot be honoured fails')
    t.is(res.fits, false)
    t.is(res.reason, 'does-not-fit', 'a real failure is distinguishable from an error')
  } else {
    // Nothing to pin layers to, so the margin never becomes unsatisfiable in
    // the way this test is probing.
    t.pass(`no accelerator present; got status ${res.status}`)
  }
})

test('a failed fit preserves the caller hard constraints', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || await ensureModelPath()

  const res = fitParams({ modelPath, nGpuLayers: 5, nCtx: 1024, marginMiB: 10000000 })

  // Hard constraints must come back untouched whatever the verdict.
  t.is(res.nGpuLayers, 5, 'pinned offload survives the fit')
  t.is(res.nCtx, 1024, 'an explicit context survives the fit')
  t.ok(res.nDevices >= 1, 'the inventory it measured against is always reported')

  if (res.nGpuDevices > 0) {
    t.is(res.status, FIT_STATUS.FAILURE, 'unmeetable pinned plan fails on a GPU host')
  } else {
    t.pass(`no accelerator present; got status ${res.status}`)
  }
})

test('an explicit context is not reduced even under memory pressure', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || await ensureModelPath()

  // Context is reduced iff it was passed as 0, so a concrete request must
  // survive pressure that would otherwise shrink it.
  const res = fitParams({ modelPath, nCtx: 2048, nCtxMin: 512, marginMiB: 10000000 })

  if (res.fits) {
    t.is(res.nCtx, 2048, 'explicit context is a hard constraint under pressure')
    if (res.nGpuDevices > 0) {
      t.is(res.nGpuLayers, 0, 'pressure is absorbed by offload, not by context')
    } else {
      t.pass('no accelerator present; nothing to absorb the pressure with')
    }
  } else {
    t.pass(`did not fit on this runner (status ${res.status})`)
  }
})

test('fitParams reports the device inventory it fitted against', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || await ensureModelPath()
  const res = fitParams({ modelPath, nCtx: 2048, nCtxMin: 512, marginMiB: 1024 })

  // Guards the regression this addon shipped with: no backend registration at
  // all, which returns a confident verdict measured against an empty device
  // list. Zero devices is now ERROR, never SUCCESS.
  t.ok(res.nDevices > 0 || res.status === FIT_STATUS.ERROR, 'zero devices can only ever report ERROR')

  // With no accelerator the fitter has nothing to decide, so n_gpu_layers stays
  // at the llama default rather than being rewritten to 0. Assert only that a
  // host-only projection never claims a positive offload.
  if (res.nGpuDevices === 0) {
    t.ok(res.nGpuLayers <= 0, 'a host-only projection never claims layers on a GPU')
  }
})

test('fitParams rejects a non-string backendsDir', async function (t) {
  await t.exception.all(
    () => fitParams({ modelPath: UNREACHABLE_MODEL, backendsDir: 42 }),
    /backendsDir must be a non-empty string/
  )
  await t.exception.all(
    () => fitParams({ modelPath: UNREACHABLE_MODEL, backendsDir: '' }),
    /backendsDir must be a non-empty string/
  )
})

test('fitParams on a missing file reports ERROR (does not throw)', function (t) {
  const res = fitParams({ modelPath: '/nonexistent/does-not-exist.gguf' })
  t.is(res.status, FIT_STATUS.ERROR, 'missing model yields ERROR status')
  t.is(res.fits, false)

  // status alone cannot separate an unreadable model from a machine with no
  // usable backend; the SDK needs to tell "retry later" from "never will work".
  t.is(res.reason, 'model-unreadable', 'the ERROR cause is distinguishable')
})
