'use strict'

// The sweep selector lives with the canonical matrix it selects from; this
// module re-exports it so the load-mode runner has one import.
const {
  parseSweepParams,
  applySweepParams,
  sweepSelection,
  validateSweepValues,
  SWEEP_PARAM_NAMES,
  GRID_PARAM_NAMES,
  ADDITIVE_PARAM_NAMES
} = require('../../test/integration/_benchmark-matrix.js')

// Dimension and cell construction for the additive load-mode sweep.
//
// Deliberately dependency-free — no bare-* and no node: imports — because the
// sweep is driven by a node orchestrator (load-mode-sweep.js) while the rest of
// the benchmark config is bare-only. Keeping this module runtime-agnostic is
// what lets one definition of the dimension serve both.
//
// Why the sweep is additive rather than crossed into PARAMETER_SWEEP: load_mode
// governs how weights reach memory and never touches the compute graph, so its
// effect is invariant across quantization and KV-cache type. Crossing it would
// replicate one curve six times. Same reasoning as BATCH_SWEEP.

// Every value LoadFitNormalization.cpp's kLoadModes accepts. 'auto' is first
// because it is the addon default (LlamaModelTest.CommonParamsParseLoadModeDefaultsToAuto)
// and therefore the baseline every margin is measured against.
const LOAD_MODES = ['auto', 'none', 'mmap', 'mlock', 'mmap+mlock', 'dio']

// 'auto' resolves against the devices the load selects, so main-gpu is
// load-bearing here in a way it is not for other dimensions: on a host with
// both an integrated and a discrete GPU the same mode is two different loads.
//
// But it is NOT swept by default. Asking for a device class the host does not
// have falls back to the CPU (README, "main-gpu"), silently producing a CPU row
// labelled as a GPU one. Pin it only on a host known to have both, with
// --load-mode-main-gpu, and check the reported backend.
function defaultMainGpus () {
  return [null]
}

// One appropriate backend per platform by default. Measuring both everywhere
// would double every leg and would ask for a GPU on the deliberately CPU-only
// runners; `device=cpu` / `device=gpu` in the selector is how a run opts into
// the other one, and that explicit choice outranks the workflow's own
// --load-mode-device (see applyCliOverrides).
function defaultDevices (platform) {
  return platform === 'android' ? ['cpu', 'gpu'] : ['gpu']
}

// One representative quantization. The ticket asks which mode wins per
// platform and device, not how the answer scales with artifact size; a second
// quantization doubles the cost without evidence that it changes the ranking.
// Widen with --load-mode-quantizations if that evidence appears.
function createLoadModeSweep (platform) {
  return {
    quantizations: ['Q4_0'],
    device: defaultDevices(platform),
    'load-mode': LOAD_MODES.slice(),
    'main-gpu': defaultMainGpus(),
    'ctx-size': '2048',
    // The probe generates only to learn which backend actually ran, so it is
    // capped at one token (as verify-prompts.js and prepare-prompts.js do for
    // their throwaway generations). Without a cap the addon default is
    // unbounded, and every sample paid for a full generation on top of the
    // load it was there to measure.
    'n-predict': '1',
    'flash-attn': 'on',
    'cache-type-k': 'f16',
    'cache-type-v': 'f16',
    threads: '4',
    'gpu-layers': '99'
  }
}

const CLI_OVERRIDES = {
  'load-mode': 'load-mode',
  'load-mode-quantizations': 'quantizations',
  'load-mode-main-gpu': 'main-gpu',
  'load-mode-device': 'device',
  'load-mode-ctx-size': 'ctx-size'
}

function splitCsv (value, key) {
  if (value === true || value == null || value === '') {
    throw new Error(`Missing value for --${key}. Expected comma-separated values.`)
  }
  const parts = String(value).split(',').map((v) => v.trim()).filter(Boolean)
  if (parts.length === 0) {
    throw new Error(`Empty value for --${key}. Expected comma-separated values.`)
  }
  return parts
}

// Narrow or widen any axis from the command line, so a run needs no code edit.
// 'none' is a legal --load-mode-main-gpu value meaning "do not set main-gpu",
// matching the config's null.
function applyCliOverrides (sweep, args) {
  const next = { ...sweep }
  // The shared selector. `load-mode=auto|mmap` narrows which modes this sweep
  // covers; naming it bare (or omitting the selector) keeps all six.
  //
  // Naming a grid axis alongside it ALSO applies here, so
  // "load-mode=auto|mmap,quantization=Q4_0|Q8_0" measures those modes at both
  // quantizations — 4 cells, not 2. That is not the same as crossing
  // load_mode into the 70-cell main grid, which stays additive: the cost here
  // is bounded by what was explicitly asked for.
  //
  // It matters because the invariance argument for keeping load_mode additive
  // covers the *ratio* between modes, not the absolute cost. Load time and
  // residency both scale with artifact bytes, so "does the mapped-vs-anonymous
  // gap hold at a larger quantization" is a real question, and the sweep
  // should be able to answer it without a code edit.
  //
  // `null` (a bare name) means every quantization the model actually has;
  // buildLoadModeCells skips the ones whose file is missing.
  // Axes the selector set by name. These outrank the --load-mode-* flags
  // below: the flags are the workflow's per-leg defaults, the selector is what
  // the dispatch explicitly asked for. Applying the flags unconditionally made
  // the documented `device=cpu|gpu` filtering a no-op on every desktop leg,
  // because the workflow always passed --load-mode-device.
  const selectorSet = new Set()
  const selected = parseSweepParams(args['sweep-params'])
  if (selected) {
    if (selected.has('load-mode')) {
      const modes = selected.get('load-mode')
      if (modes !== null) { next['load-mode'] = modes.slice(); selectorSet.add('load-mode') }
    }
    if (selected.has('quantization')) {
      const quants = selected.get('quantization')
      next.quantizations = quants === null ? null : quants.slice()
      selectorSet.add('quantizations')
    }
    if (selected.has('device')) {
      const devices = selected.get('device')
      if (devices !== null) { next.device = devices.slice(); selectorSet.add('device') }
    }
    if (selected.has('ctx-size')) {
      const ctx = selected.get('ctx-size')
      if (ctx !== null) {
        // The load-mode sweep holds one context: load cost scales with
        // artifact bytes, not context, so a second value would duplicate every
        // cell for no new signal. Silently taking the first would be worse
        // than refusing — a discarded value looks like a measurement.
        if (ctx.length > 1) {
          throw new Error(
            `ctx-size takes one value in a load-mode sweep, got ${ctx.length} (${ctx.join(', ')}). ` +
            'Load cost scales with artifact bytes, not context.'
          )
        }
        next['ctx-size'] = ctx[0]
        selectorSet.add('ctx-size')
      }
    }
    // Axes the load-mode sweep has no dimension for. Naming one alongside
    // load-mode used to be accepted and then ignored, so the run silently
    // measured something other than what was asked for.
    const unsupported = ['threads', 'flash-attn', 'cache-type-k', 'cache-type-v', 'batch-size', 'ubatch-size', 'reasoning-budget']
      .filter((name) => selected.has(name))
    if (selected.has('load-mode') && unsupported.length > 0) {
      throw new Error(
        `${unsupported.join(', ')} cannot be crossed with load-mode: the load-mode sweep pins ` +
        'them at a fixed baseline (they affect the compute graph, not how weights reach memory). ' +
        'Run them as their own selector against the parameter grid instead.'
      )
    }
  }
  for (const [argKey, sweepKey] of Object.entries(CLI_OVERRIDES)) {
    if (!Object.prototype.hasOwnProperty.call(args, argKey)) continue
    if (selectorSet.has(sweepKey)) continue
    const values = splitCsv(args[argKey], argKey)
    if (sweepKey === 'main-gpu') {
      next[sweepKey] = values.map((v) => (v === 'none' ? null : v))
    } else if (sweepKey === 'ctx-size') {
      next[sweepKey] = values[0]
    } else {
      next[sweepKey] = values
    }
  }
  const unknown = Object.keys(args).filter((k) => k.startsWith('load-mode-') && !CLI_OVERRIDES[k])
  if (unknown.length > 0) {
    throw new Error(`Unknown load-mode option(s): ${unknown.map((k) => `--${k}`).join(', ')}`)
  }
  return next
}

// modelEntries: [{ id, modelDir, quantizationFiles: { Q4_0: 'file.gguf' } }]
function buildLoadModeCells (modelEntries, sweep) {
  const cells = []
  for (const model of modelEntries) {
    // null quantizations means "every one this model has" — what a bare
    // `quantization` in the selector asks for. The model's own file map is
    // the only place that list exists, so it is resolved per model here.
    const quantizations = sweep.quantizations === null
      ? Object.keys(model.quantizationFiles)
      : sweep.quantizations
    for (const quantization of quantizations) {
      const modelName = model.quantizationFiles[quantization]
      if (!modelName) continue
      for (const device of sweep.device) {
        for (const mainGpu of sweep['main-gpu']) {
          // main-gpu selects nothing on a CPU load; pinning it there would add
          // duplicate cells differing only in caseId.
          if (device !== 'gpu' && mainGpu !== null) continue
          for (const mode of sweep['load-mode']) {
            const config = {
              device,
              'gpu-layers': device === 'gpu' ? sweep['gpu-layers'] : '0',
              'ctx-size': sweep['ctx-size'],
              'flash-attn': sweep['flash-attn'],
              'cache-type-k': sweep['cache-type-k'],
              'cache-type-v': sweep['cache-type-v'],
              threads: sweep.threads,
              'n-predict': sweep['n-predict'],
              'load-mode': mode
            }
            if (mainGpu !== null) config['main-gpu'] = mainGpu
            const gpuSuffix = mainGpu !== null ? `__mg=${mainGpu}` : ''
            cells.push({
              caseId: `${model.id}__q=${quantization}__dev=${device}${gpuSuffix}__lm=${mode}`,
              modelId: model.id,
              modelDir: model.modelDir,
              modelName,
              quantization,
              device,
              mainGpu,
              mode,
              config
            })
          }
        }
      }
    }
  }
  return cells
}

module.exports = {
  LOAD_MODES,
  SWEEP_PARAM_NAMES,
  createLoadModeSweep,
  applyCliOverrides,
  buildLoadModeCells,
  parseSweepParams,
  applySweepParams,
  sweepSelection,
  validateSweepValues,
  GRID_PARAM_NAMES,
  ADDITIVE_PARAM_NAMES
}
