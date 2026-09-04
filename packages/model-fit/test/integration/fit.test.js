'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const { fitParams, FIT_STATUS } = require('../../index.js')
const { ensureModelPath } = require('./utils')

// Deliberately never created. Argument validation must reject configs using it
// before any file is opened, so these cases never reach the fitter.
//
// Built from cwd for the same reason as UNREACHABLE_BACKENDS_DIR below: it has
// to clear the absoluteness check on every platform so these cases fail on the
// argument they are actually probing.
const UNREACHABLE_MODEL = path.join(
  process.cwd(),
  'model-fit-validation-only',
  'never-created.gguf'
)

// Absolute on every platform, and never created. Built from cwd rather than
// written as '/…' because win32 treats a rootless '/foo' as *relative* (no
// drive letter), which would trip the absoluteness check instead of the
// existence check the test is aiming at.
const UNREACHABLE_BACKENDS_DIR = path.join(process.cwd(), 'model-fit-no-such-backends-dir')

test('fitParams rejects invalid config', async function (t) {
  await t.exception.all(() => fitParams(), /config object is required/)
  await t.exception.all(() => fitParams(null), /config object is required/)
  await t.exception.all(() => fitParams({}), /modelPath must be a non-empty string/)
  await t.exception.all(() => fitParams({ modelPath: '' }), /modelPath must be a non-empty string/)
  await t.exception.all(
    () => fitParams({ modelPath: UNREACHABLE_MODEL, nCtx: 'big' }),
    /nCtx must be a safe integer/
  )
})

test('fitParams rejects values that would truncate or wrap in the binding', async function (t) {
  const base = { modelPath: UNREACHABLE_MODEL }

  // Fractions truncate on the way to uint32_t/int32_t.
  await t.exception.all(() => fitParams({ ...base, nCtx: 4096.5 }), /nCtx must be a safe integer/)
  await t.exception.all(
    () => fitParams({ ...base, marginMiB: 0.5 }),
    /marginMiB must be a safe integer/
  )
  await t.exception.all(() => fitParams({ ...base, nCtx: NaN }), /nCtx must be a safe integer/)
  await t.exception.all(() => fitParams({ ...base, nCtx: Infinity }), /nCtx must be a safe integer/)

  // Negatives wrap on unsigned fields: marginMiB -1 would become a margin
  // nothing can satisfy. nGpuLayers is exempt — see the next test.
  await t.exception.all(() => fitParams({ ...base, marginMiB: -1 }), /marginMiB must be between/)
  await t.exception.all(() => fitParams({ ...base, nCtxMin: -1 }), /nCtxMin must be between/)

  // Above the width of the target integer type.
  await t.exception.all(() => fitParams({ ...base, nCtx: 4294967296 }), /nCtx must be between/)
  await t.exception.all(
    () => fitParams({ ...base, nGpuLayers: 2147483648 }),
    /nGpuLayers must be between/
  )

  // Relationships the fitter would otherwise reinterpret or reject obscurely.
  await t.exception.all(
    () => fitParams({ ...base, nBatch: 256, nUbatch: 512 }),
    /nUbatch must not exceed/
  )
  await t.exception.all(
    () => fitParams({ ...base, nCtx: 512, nCtxMin: 1024 }),
    /nCtxMin must not exceed/
  )
})

test('intended-load fields are bounded to their enum domains', async function (t) {
  const base = { modelPath: UNREACHABLE_MODEL }

  // These narrow to a C enum, not just an int, so the width of int32 is the
  // wrong bound: an out-of-range value would reach llama as a garbage enum.
  await t.exception.all(() => fitParams({ ...base, splitMode: 4 }), /splitMode must be between/)
  await t.exception.all(() => fitParams({ ...base, splitMode: -1 }), /splitMode must be between/)
  await t.exception.all(
    () => fitParams({ ...base, flashAttnType: 2 }),
    /flashAttnType must be between/
  )
  await t.exception.all(
    () => fitParams({ ...base, flashAttnType: -2 }),
    /flashAttnType must be between/
  )
  t.is(
    fitParams({ ...base, nGpuLayers: 0, splitMode: 0, mainGpu: -1 }).status,
    FIT_STATUS.ERROR,
    'the CPU sentinel passes wrapper validation'
  )
  await t.exception.all(() => fitParams({ ...base, mainGpu: -2 }), /mainGpu must be between/)
  await t.exception.all(
    () => fitParams({ ...base, nGpuLayers: 1, splitMode: 0, mainGpu: -1 }),
    /mainGpu -1 requires/
  )
  await t.exception.all(
    () => fitParams({ ...base, nGpuLayers: 0, splitMode: 1, mainGpu: -1 }),
    /mainGpu -1 requires/
  )
  await t.exception.all(() => fitParams({ ...base, typeK: -1 }), /typeK must be between/)
  await t.exception.all(() => fitParams({ ...base, typeV: 1.5 }), /typeV must be a safe integer/)

  // The exact ggml_type ceiling lives natively, where it is compiled against
  // the same ggml.h rather than duplicated as a constant that drifts on a bump.
  const binding = require('../../binding.js')
  await t.exception.all(
    () => binding.paramsFit({ modelPath: UNREACHABLE_MODEL, typeK: 100000 }),
    /out of range/
  )
  await t.exception.all(
    () => binding.paramsFit({ modelPath: UNREACHABLE_MODEL, splitMode: 4 }),
    /out of range/
  )
  t.is(
    binding.paramsFit({
      modelPath: UNREACHABLE_MODEL,
      nGpuLayers: 0,
      splitMode: 0,
      mainGpu: -1
    }).status,
    FIT_STATUS.ERROR,
    'the CPU sentinel passes native validation'
  )
  await t.exception.all(
    () => binding.paramsFit({ modelPath: UNREACHABLE_MODEL, mainGpu: -2 }),
    /out of range/
  )
  await t.exception.all(
    () =>
      binding.paramsFit({
        modelPath: UNREACHABLE_MODEL,
        nGpuLayers: 1,
        splitMode: 0,
        mainGpu: -1
      }),
    /mainGpu.*-1.*requires/
  )
})

test('swaFull rejects non-boolean values at both public boundaries', async function (t) {
  const base = { modelPath: UNREACHABLE_MODEL }
  const binding = require('../../binding.js')

  await t.exception.all(() => fitParams({ ...base, swaFull: 1 }), /swaFull must be a boolean/)
  for (const swaFull of [null, 1, 'true', {}]) {
    await t.exception.all(() => binding.paramsFit({ ...base, swaFull }), /swaFull.*boolean/)
  }

  t.is(binding.paramsFit(base).status, FIT_STATUS.ERROR, 'absent remains omitted')
  t.is(
    binding.paramsFit({ ...base, swaFull: undefined }).status,
    FIT_STATUS.ERROR,
    'undefined remains omitted'
  )
})

test('a pinned intended-load field is returned unchanged', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || (await ensureModelPath())

  // The upstream contract is that only default-valued parameters get rewritten,
  // so stating an intended load pins it: the projection has to fit *around* the
  // decision rather than quietly substituting its own. Without this, a caller
  // that already knows it will load with a quantised KV would get a projection
  // measured against llama's F16 default and an answer that does not describe
  // the load it is about to perform.
  //
  // LLAMA_SPLIT_MODE_NONE (0) is a non-default value (the default is LAYER, 1),
  // so it genuinely pins rather than being indistinguishable from omission.
  const config = { modelPath, nCtx: 2048, marginMiB: 1024, splitMode: 0, mainGpu: 0 }

  // NONE says "the whole model goes on one GPU". On a host with none, llama
  // rejects every device index — including the default 0 — so the placement is
  // unsatisfiable and is reported as such rather than being run and returned as
  // an opaque ERROR the caller cannot distinguish from a real fit failure.
  if (fitParams({ modelPath }).nGpuDevices === 0) {
    await t.exception.all(() => fitParams(config), /no GPU device is registered/)
    return
  }

  const res = fitParams(config)

  t.not(res.status, FIT_STATUS.ERROR, 'a pinned placement is accepted, not rejected')
  t.is(res.splitMode, 0, 'the pinned split mode survives the fit')
  t.is(res.mainGpu, 0, 'the pinned main GPU survives the fit')
})

test('an explicit CPU placement reaches the fitter and preserves its sentinel', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || (await ensureModelPath())
  const res = fitParams({
    modelPath,
    nCtx: 512,
    nGpuLayers: 0,
    splitMode: 0,
    mainGpu: -1
  })

  t.is(res.status, FIT_STATUS.SUCCESS, 'the CPU placement reaches common_fit_params')
  t.is(res.nGpuLayers, 0, 'the CPU layer count survives the fit')
  t.is(res.splitMode, 0, 'the CPU split mode survives the fit')
  t.is(res.mainGpu, -1, 'the CPU sentinel survives the fit')
})

test('binding.paramsFit enforces the same constraints as the wrapper', async function (t) {
  // ./binding.js is a public export, so these checks cannot live only in the
  // JS wrapper — a caller can reach the native entry point directly.
  const binding = require('../../binding.js')

  await t.exception.all(
    () => binding.paramsFit({ modelPath: UNREACHABLE_MODEL, marginMiB: -1 }),
    /out of range/
  )
  await t.exception.all(
    () => binding.paramsFit({ modelPath: UNREACHABLE_MODEL, nCtx: 4096.5 }),
    /must be an integer/
  )
  await t.exception.all(
    () => binding.paramsFit({ modelPath: UNREACHABLE_MODEL, nBatch: 256, nUbatch: 512 }),
    /must not exceed/
  )
})

test('FIT_STATUS enum matches common_params_fit_status', function (t) {
  t.is(FIT_STATUS.SUCCESS, 0)
  t.is(FIT_STATUS.FAILURE, 1)
  t.is(FIT_STATUS.ERROR, 2)
})

test('fitParams on a real GGUF projects a load plan', async function (t) {
  // Use a caller-supplied model when provided (local runs against a real
  // model), otherwise download the tiny public GGUF so CI exercises the real
  // projection path on every platform.
  const modelPath = process.env.FIT_MODEL_PATH || (await ensureModelPath())
  t.ok(fs.existsSync(modelPath), `model exists at ${modelPath}`)

  // 2048 is what stories260K declares as its context length; asking for more is
  // now rejected outright, so this is the largest concrete request it accepts.
  const res = fitParams({ modelPath, nCtx: 2048, nCtxMin: 512, marginMiB: 1024 })

  t.ok(
    [FIT_STATUS.SUCCESS, FIT_STATUS.FAILURE, FIT_STATUS.ERROR].includes(res.status),
    'status is a known code'
  )
  t.is(typeof res.fits, 'boolean')
  t.is(typeof res.nGpuLayers, 'number')
  t.is(typeof res.nCtx, 'number')
  t.ok(Array.isArray(res.tensorSplit), 'tensorSplit is an array')
  t.is(res.tensorSplit.length, res.maxDevices, 'tensorSplit has one entry per device')

  // maxDevices is llama_max_devices(), a build-time bound, so it proves nothing
  // about detection. nDevices is the real inventory: backends registered, the
  // fitter had a machine to measure, and the projection means something.
  t.ok(Array.isArray(res.buftOverrides), 'placement the projection depended on is reported')
  t.ok(
    ['fits', 'does-not-fit', 'model-unreadable', 'no-backend-device'].includes(res.reason),
    'reason is a known code'
  )
  t.ok(res.nDevices >= 1, 'at least one backend device was actually registered')
  t.ok(res.nDevices <= res.maxDevices, 'detected devices within addressable bound')
  t.ok(res.nGpuDevices <= res.nDevices, 'accelerator count is a subset of all devices')
  t.not(
    res.status,
    FIT_STATUS.ERROR,
    'a registered device must not yield ERROR on a readable model'
  )

  if (res.fits) {
    t.ok(res.nCtx >= 512 && res.nCtx <= 2048, 'fitted context within [nCtxMin, requested]')
    // The README defines an explicit nCtx as a hard constraint, not a hint:
    // llama only reduces the context when it is 0.
    t.is(res.nCtx, 2048, 'an explicitly requested context is returned unchanged')
  }
})

test('a decided verdict carries its per-device memory projection', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || (await ensureModelPath())
  const res = fitParams({ modelPath, nCtx: 2048, nCtxMin: 512, marginMiB: 1024 })

  // SUCCESS and FAILURE both explain themselves; only ERROR has no resolved
  // parameters to project. The probe is allowed to fail independently, but on
  // a healthy host with a readable model it must produce the rows.
  t.not(res.status, FIT_STATUS.ERROR, 'fixture yields a decided verdict')
  t.ok(Array.isArray(res.projection), 'projection is present on a decided verdict')
  t.ok(res.projection.length >= 1, 'projection has at least the host row')

  const host = res.projection[res.projection.length - 1]
  t.is(host.name, 'host', 'the trailing row is the host')
  for (const row of res.projection) {
    t.ok(typeof row.name === 'string' && row.name.length > 0, 'row is named')
    for (const key of ['totalBytes', 'freeBytes', 'modelBytes', 'contextBytes', 'computeBytes']) {
      t.ok(
        Number.isFinite(row[key]) && row[key] >= 0,
        `${row.name}.${key} is a non-negative number`
      )
    }
  }

  // The projection must describe THIS load, not a generic machine snapshot:
  // a readable model's weight bytes have to land somewhere.
  const projectedModelBytes = res.projection.reduce((sum, row) => sum + row.modelBytes, 0)
  t.ok(projectedModelBytes > 0, 'the model bytes were projected onto some row')
})

test('the plan carries every parameter the fitter is free to rewrite', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || (await ensureModelPath())
  const res = fitParams({ modelPath, nCtx: 2048, nCtxMin: 512, marginMiB: 1024 })

  // llama.h: "only parameters that have the same value as in
  // llama_default_model_params are modified". This addon hands the fitter
  // defaults for everything the caller did not pin, so every one of these is
  // eligible to come back rewritten. A field the fitter changes but the result
  // drops is the exact defect this guards: the caller would then load with its
  // own default, get different placement than the one projected to fit, and
  // have no way to tell. Assert presence field-by-field so that adding a new
  // mutable parameter without serialising it fails here rather than silently
  // shipping an unreproducible plan.
  for (const field of [
    'nGpuLayers',
    'nCtx',
    'nBatch',
    'nUbatch',
    'splitMode',
    'mainGpu',
    'typeK',
    'typeV',
    'flashAttnType'
  ]) {
    t.is(typeof res[field], 'number', `${field} is serialised onto the plan`)
    t.ok(Number.isInteger(res[field]), `${field} is a concrete integer, not a placeholder`)
  }

  // Domains from llama.h, so a garbage readback (uninitialised memory, wrong
  // cast width) is caught rather than passing as "a number".
  t.ok(res.splitMode >= 0 && res.splitMode <= 3, 'splitMode is a known llama_split_mode')
  t.ok(res.mainGpu >= 0, 'mainGpu is a device index')
  t.ok(res.mainGpu < Math.max(res.nDevices, 1), 'mainGpu points at a device that exists')
  t.ok(res.typeK >= 0, 'typeK is a ggml_type')
  t.ok(res.typeV >= 0, 'typeV is a ggml_type')
  t.ok([-1, 0, 1].includes(res.flashAttnType), 'flashAttnType is a known llama_flash_attn_type')

  // On a host-only projection there is nothing to split across, so the fitter
  // has no reason to move off the single-GPU/first-device placement. This is
  // what makes the plan reproducible on the machine it was measured on.
  if (res.nGpuDevices === 0) {
    t.is(res.mainGpu, 0, 'host-only projection stays on the first device')
  }
})

test('a context beyond what the model declares is rejected', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || (await ensureModelPath())

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

  // The declared length itself must still be accepted, and one below it.
  const res = fitParams({ modelPath, nCtx: 2048 })
  t.not(res.status, FIT_STATUS.ERROR, 'the declared context length is allowed')

  const below = fitParams({ modelPath, nCtx: 2047 })
  t.not(below.status, FIT_STATUS.ERROR, 'below the declared length is allowed')

  // 0 means "let the fitter choose" and must not be caught by the bound.
  const auto = fitParams({ modelPath, nCtx: 0 })
  t.not(auto.status, FIT_STATUS.ERROR, 'nCtx 0 is unaffected by the bound')

  // The bound lives in native code, and ./binding.js is a public export that
  // bypasses the JS wrapper entirely — so it has to hold there too.
  const binding = require('../../binding.js')
  await t.exception.all(
    () => binding.paramsFit({ modelPath, nCtx: 100000000 }),
    /exceeds the context length the model declares/
  )

  // The value that reproduces the upstream abort (ggml-org/llama.cpp#26268) is
  // now refused before llama sees it. Regression guard: if the bound is ever
  // removed, this call takes the whole process down rather than failing.
  await t.exception.all(
    () => fitParams({ modelPath, nCtx: 75000000 }),
    /exceeds the context length the model declares/
  )
})

test('a context floor beyond what the model declares is rejected', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || (await ensureModelPath())

  // The `nCtxMin <= nCtx` relationship check only applies when nCtx is
  // concrete. Left at 0 — the documented way to let the fitter choose — an
  // arbitrary floor used to pass every check and reach common_fit_params
  // unbounded, so the ceiling was policed and the floor beside it was not.
  await t.exception.all(
    () => fitParams({ modelPath, nCtx: 0, nCtxMin: 75000000 }),
    /nCtxMin 75000000 exceeds the context length the model declares/
  )
  await t.exception.all(
    () => fitParams({ modelPath, nCtx: 0, nCtxMin: 2049 }),
    /nCtxMin 2049 exceeds the context length the model declares/
  )

  // The declared length itself is a floor the model can serve.
  const atDeclared = fitParams({ modelPath, nCtx: 0, nCtxMin: 2048 })
  t.not(atDeclared.status, FIT_STATUS.ERROR, 'a floor at the declared length is allowed')

  // Omitting it must stay valid on a model trained shorter than the 4096
  // default: that value is this package's, not the caller's, so it is clamped
  // rather than thrown over.
  const defaulted = fitParams({ modelPath, nCtx: 0 })
  t.not(defaulted.status, FIT_STATUS.ERROR, 'the default floor is clamped, not rejected')

  // ./binding.js is a public export, so the bound cannot live only in runFit's
  // caller — it has to hold on the native entry point too.
  const binding = require('../../binding.js')
  await t.exception.all(
    () => binding.paramsFit({ modelPath, nCtx: 0, nCtxMin: 75000000 }),
    /nCtxMin 75000000 exceeds the context length the model declares/
  )
})

test('a successful plan always carries a concrete context', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || (await ensureModelPath())

  // Unresolved context metadata is not a usable load plan.
  const res = fitParams({ modelPath, nCtx: 0, marginMiB: 1024 })

  if (res.fits) {
    t.ok(res.nCtx > 0, 'a fitted plan never reports a context of zero')
  } else {
    t.pass(
      `model did not fit on this runner (status ${res.status}); context resolution not exercised`
    )
  }
})

test('a negative nGpuLayers is valid input meaning "all layers"', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || (await ensureModelPath())

  // llama.h: "number of layers to store in VRAM, a negative value means all
  // layers". It is the llama default, and what upstream's own fit-params prints
  // back (`-ngl -1`), so it must not be rejected as out of range.
  const res = fitParams({ modelPath, nGpuLayers: -1, marginMiB: 1024 })

  t.ok(
    [FIT_STATUS.SUCCESS, FIT_STATUS.FAILURE, FIT_STATUS.ERROR].includes(res.status),
    'accepted, not rejected'
  )

  // Deliberately not asserting the value comes back as -1. The fitter only
  // rewrites fields still holding their llama default, and -1 *is* the default
  // for n_gpu_layers — so passing it is indistinguishable from passing nothing
  // and the fitter stays free to choose. Pinning requires a non-default value.
  t.is(typeof res.nGpuLayers, 'number', 'a plan is still returned')
})

test('a non-default nGpuLayers is what actually pins the offload', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || (await ensureModelPath())

  // 0 is non-default, so unlike -1 it is a real constraint the fitter honours.
  const res = fitParams({ modelPath, nGpuLayers: 0, marginMiB: 1024 })

  t.is(res.nGpuLayers, 0, 'a non-default pin is preserved')
})

test('memory pressure moves the plan off the GPU rather than reporting FAILURE', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || (await ensureModelPath())

  // `common_fit_params` fits to free *device* memory and, per common/fit.h,
  // "assumes system memory is unlimited". So an unmeetable device margin is satisfied by
  // moving every layer to the host and shrinking the context — not by returning
  // FAILURE. Driving this with the margin rather than with a large model keeps
  // it deterministic: a model sized to overflow one CI runner's VRAM fits the
  // next one, whereas no device can honour a multi-TiB margin.
  //
  // This is the load-bearing behaviour for anything gating admission: `fits`
  // stays true under extreme pressure, so the plan is the signal, not the flag.
  const res = fitParams({ modelPath, nCtx: 0, marginMiB: 10000000 })

  // The fallback is "off the GPU and onto the host", so it only exists where
  // there is a GPU. On a host-only machine the host *is* the only device, the
  // margin applies to it, and nothing can be moved anywhere — so FAILURE is the
  // correct verdict rather than a fit nobody could honour. qvac-fabric 9840
  // reports it that way; 8828 returned SUCCESS here.
  if (res.nGpuDevices === 0) {
    t.is(res.status, FIT_STATUS.FAILURE, 'host-only: an unmeetable margin has no fallback')
    t.is(res.fits, false)
    t.is(res.reason, 'does-not-fit', 'and it is a fit verdict, not an error')
    return
  }

  t.is(res.status, FIT_STATUS.SUCCESS, 'host fallback is still reported as a fit')
  t.is(res.fits, true)
  t.ok(res.nCtx > 0, 'a fitted plan still carries a concrete context')
  t.ok(res.nCtx <= 2048, 'context was reduced, not left at the trained maximum')
  t.is(res.nGpuLayers, 0, 'an unsatisfiable device margin offloads nothing to GPU')
})

test('pinned offload under pressure is the only way to get FAILURE', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || (await ensureModelPath())

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
  const modelPath = process.env.FIT_MODEL_PATH || (await ensureModelPath())

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
  const modelPath = process.env.FIT_MODEL_PATH || (await ensureModelPath())

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
  const modelPath = process.env.FIT_MODEL_PATH || (await ensureModelPath())
  const res = fitParams({ modelPath, nCtx: 2048, nCtxMin: 512, marginMiB: 1024 })

  // Guards the regression this addon shipped with: no backend registration at
  // all, which returns a confident verdict measured against an empty device
  // list. Zero devices is now ERROR, never SUCCESS.
  t.ok(
    res.nDevices > 0 || res.status === FIT_STATUS.ERROR,
    'zero devices can only ever report ERROR'
  )

  // With no accelerator the fitter has nothing to decide, so n_gpu_layers stays
  // at the llama default rather than being rewritten to 0. Assert only that a
  // host-only projection never claims a positive offload.
  if (res.nGpuDevices === 0) {
    t.ok(res.nGpuLayers <= 0, 'a host-only projection never claims layers on a GPU')
  }
})

// The API documents modelPath as absolute, and a relative one resolves against
// the process working directory — which nothing in a worklet controls, so the
// same call names a different file depending on where the host was launched.
test('fitParams rejects a relative modelPath', async function (t) {
  await t.exception.all(
    () => fitParams({ modelPath: 'models/foo.gguf' }),
    /modelPath must be an absolute path/
  )
  await t.exception.all(
    () => fitParams({ modelPath: './foo.gguf' }),
    /modelPath must be an absolute path/
  )
  await t.exception.all(
    () => fitParams({ modelPath: '../foo.gguf' }),
    /modelPath must be an absolute path/
  )

  // ./binding.js is a public export, so the wrapper's check can be bypassed
  // entirely — the bound has to hold natively too.
  const binding = require('../../binding.js')
  await t.exception.all(
    () => binding.paramsFit({ modelPath: 'models/foo.gguf' }),
    /modelPath must be an absolute path/
  )
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

// Everything found in backendsDir is dlopen'd into this process, so the path is
// checked before it gets there rather than being handed over as given.
test('fitParams rejects a backendsDir it will not dlopen from', async function (t) {
  await t.exception.all(
    () => fitParams({ modelPath: UNREACHABLE_MODEL, backendsDir: 'relative/backends' }),
    /backendsDir must be an absolute path/
  )
  await t.exception.all(
    () => fitParams({ modelPath: UNREACHABLE_MODEL, backendsDir: UNREACHABLE_BACKENDS_DIR }),
    /backendsDir is not an existing directory/
  )
})

// The fitter ignores main_gpu entirely, so a bad placement used to surface only
// as llama failing the internal load — a bare ERROR indistinguishable from a
// genuine "does not fit". Both rejections below are scoped to SPLIT_MODE_NONE,
// the only mode under which llama reads the field.
test('an unsatisfiable SPLIT_MODE_NONE placement is rejected', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || (await ensureModelPath())
  const nGpuDevices = fitParams({ modelPath }).nGpuDevices

  if (nGpuDevices === 0) {
    // No GPU at all: NONE cannot be satisfied by any index, the default included.
    await t.exception.all(
      () => fitParams({ modelPath: UNREACHABLE_MODEL, splitMode: 0, mainGpu: 0 }),
      /no GPU device is registered/
    )
  } else {
    await t.exception.all(
      () => fitParams({ modelPath: UNREACHABLE_MODEL, splitMode: 0, mainGpu: nGpuDevices }),
      /mainGpu \d+ is out of range/
    )
  }

  // Outside NONE the field is inert, so the same index must not be rejected —
  // the guard has to stay scoped rather than becoming a blanket bound.
  const res = fitParams({ modelPath, splitMode: 1, mainGpu: nGpuDevices })
  t.not(res.status, FIT_STATUS.ERROR, 'mainGpu is not policed outside SPLIT_MODE_NONE')
})

test('fitParams on a missing file reports ERROR (does not throw)', function (t) {
  // Absolute and non-existent. A rootless '/nonexistent/…' would be rejected as
  // relative on win32 before the file is ever opened, turning the outcome this
  // test asserts — ERROR, not a throw — into a throw on one platform only.
  const res = fitParams({
    modelPath: path.join(process.cwd(), 'nonexistent', 'does-not-exist.gguf')
  })
  t.is(res.status, FIT_STATUS.ERROR, 'missing model yields ERROR status')
  t.is(res.fits, false)

  // status alone cannot separate an unreadable model from a machine with no
  // usable backend; the SDK needs to tell "retry later" from "never will work".
  t.is(res.reason, 'model-unreadable', 'the ERROR cause is distinguishable')
})
