'use strict'

// Integration coverage for the *private* addon surface.
//
// These cases live apart from fit.test.js because they reach
// `../../binding-internal.js`, which is packaged (see `files`) but deliberately
// absent from `exports`. The mobile test framework stages this directory into
// its own `backend/` tree and shims only the public entry points there
// (`index.js`, `binding.js`, `addon.js`), so a bundle that traverses this file
// fails to resolve the private surface and the whole mobile app build dies.
//
// This file is therefore excluded from the generated mobile suite — see
// scripts/mobile-integration-exclusions.js. It still runs on desktop as part of
// `npm run test:integration:suite`, which globs test/integration/*.test.js.

const test = require('brittle')
const path = require('bare-path')
const process = require('bare-process')
const { ensureModelPath } = require('./utils')

// The raw load-config fitter lives on the private surface: `../../binding.js`
// is a public export and deliberately carries `paramsFit` only.
const binding = require('../../binding-internal.js')

// Deliberately never created. Argument validation must reject configs using it
// before any file is opened, so these cases never reach the fitter.
//
// Built from cwd so it clears the absoluteness check on every platform, and the
// cases fail on the argument they are actually probing.
const UNREACHABLE_MODEL = path.join(
  process.cwd(),
  'model-fit-validation-only',
  'never-created.gguf'
)

test('native raw fitting validates load kind, params, and relationships', async function (t) {
  const base = { modelPath: UNREACHABLE_MODEL }

  await t.exception.all(
    () => binding.llamaConfigFit({ ...base, params: { device: 'cpu' } }),
    /loadKind/
  )
  await t.exception.all(
    () =>
      binding.llamaConfigFit({
        loadKind: 'completion',
        ...base,
        params: { device: 1 }
      }),
    /values must be strings/
  )
  await t.exception.all(
    () =>
      binding.llamaConfigFit({
        loadKind: 'completion',
        ...base,
        params: { device: 'cpu', 'batch-size': '128', 'ubatch-size': '256' }
      }),
    /ubatch-size must not exceed batch-size/
  )
  await t.exception.all(
    () =>
      binding.llamaConfigFit({
        loadKind: 'completion',
        ...base,
        params: { device: 'cpu', 'ctx-size': '512' },
        nCtxMin: 1024
      }),
    // The native message quotes its field names; the JS wrapper's does not, so
    // the loose pattern used for `fitParams` never matched here.
    /'nCtxMin' must not exceed concrete 'ctx-size'/
  )
})

test('native raw fitting uses explicit completion and embedding load kinds', async function (t) {
  const modelPath = process.env.FIT_MODEL_PATH || (await ensureModelPath())
  const completion = binding.llamaConfigFit({
    loadKind: 'completion',
    modelPath,
    params: {
      device: 'cpu',
      'ctx-size': '512',
      'batch-size': '128',
      'ubatch-size': '64',
      parallel: '1',
      'gpu-layers': '0',
      'no-mmap': 'true',
      'swa-full': ''
    },
    nCtxMin: 512
  })
  const embedding = binding.llamaConfigFit({
    loadKind: 'embedding',
    modelPath,
    params: {
      device: 'cpu',
      'ctx-size': '512',
      'batch-size': '128',
      'ubatch-size': '64'
    },
    nCtxMin: 512
  })

  t.not(completion.reason, 'unsupported-config', 'completion config reaches common_fit_params')
  t.not(embedding.reason, 'unsupported-config', 'embedding config reaches common_fit_params')

  // CPU placement is the zero-device list (`devices = {nullptr}`), not a pinned
  // `n_gpu_layers` — the addons leave that field alone on their CPU path, and
  // pinning it to 0 made `common_fit_params` abort when it needed to adjust it.
  //
  // These two are post-fit *outputs*, though, and the fitter rewrites what it
  // needs while searching: on a host that registers a GPU but is handed a
  // zero-device list it reports the host-memory plan as ngl 0 / main-gpu 0,
  // where elsewhere it returns the values it was given. So assert what holds on
  // every host — a CPU request never comes back offloading layers — and leave
  // the exact input placement to `isCpuPlacement` in LlamaLoadConfig.test.cpp,
  // which drives `normalizeLlamaLoadConfig` against a synthetic device list and
  // therefore pins `devices == {nullptr}` and `main_gpu == -1` with no platform
  // dependence at all.
  t.is(completion.nGpuLayers, 0, 'an explicit gpu-layers is passed through')
  t.ok(embedding.nGpuLayers <= 0, 'an embedding CPU config offloads no layers')
})
