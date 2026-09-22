'use strict'

// Single source of truth for the mobile perf benchmark matrix. The per-shard
// test files (benchmark-perf-<size>-<quant>-<cache>.test.js) and the Benchmark
// Performance workflow's test_groups override are both generated from this
// list by scripts/generate-benchmark-shards.js, so the 2 x 5 x 7 matrix is
// defined in exactly one place. Underscore prefix keeps it out of the test
// globs (it is not a *.test.js file).

const SIZES = ['0.8B', '2B']
const QUANTS = ['Q4_0', 'Q4_1', 'Q4_K_M', 'Q6_K', 'Q8_0']
// KV-cache types as (k, v) pairs. f16/q8_0/q4_0 are symmetric (k === v); the
// TurboQuant/PolarQuant schemes pair a TBQ or PQ key with a PQ value, so k may
// differ from v. TBQ/PQ ship Vulkan + CPU kernels only, so they are reported as
// Crashed on Metal (iOS) and on GPUs that lack support (e.g. Samsung).
const CACHE_TYPES = [
  { k: 'f16', v: 'f16' },
  { k: 'q8_0', v: 'q8_0' },
  { k: 'q4_0', v: 'q4_0' },
  { k: 'tbq3_0', v: 'pq3_0' },
  { k: 'tbq4_0', v: 'pq4_0' },
  { k: 'pq3_0', v: 'pq3_0' },
  { k: 'pq4_0', v: 'pq4_0' }
]

// Additive batch/ubatch sweep, kept SEPARATE from the cross-product above rather
// than crossed into it. batch-size/ubatch-size only affect prefill throughput
// and their effect is invariant across quantization and KV-cache type, so
// sweeping batch once at a fixed baseline (quant BATCH_SWEEP_QUANT, symmetric
// f16 KV) adds a handful of shards instead of multiplying the whole matrix.
// Each batch cell carries a `batch` field; the cross-product cells above do not,
// so their shard names, keys and labels are unchanged. batch === ubatch (set on
// device by the runner). See benchmarks/performance for the desktop twin.
const BATCH_SWEEP_QUANT = 'Q4_0'
const BATCH_SWEEP_CACHE = { k: 'f16', v: 'f16' }
const BATCH_SWEEP_SIZES = [512, 1024]

// Additive load-mode sweep, separate from the cross-product for the same
// reason the batch sweep is: load_mode governs how weights reach memory and
// never touches the compute graph, so its effect is invariant across
// quantization and KV-cache type. Six modes at one size and quant adds six
// cells rather than multiplying 70.
//
// Android is the reason this axis matters on mobile at all: Adreno's OpenCL
// backend reports no mmap support, so 'auto' resolves to the anonymous path
// there while it maps on Metal. That divergence cannot be observed on desktop.
//
// Every value LoadFitNormalization.cpp's kLoadModes accepts. 'auto' is the
// addon default and the baseline the others are compared against.
const LOAD_MODES = ['auto', 'none', 'mmap', 'mlock', 'mmap+mlock', 'dio']
const LOAD_MODE_SIZE = '0.8B'
const LOAD_MODE_QUANT = 'Q4_0'
const LOAD_MODE_CACHE = { k: 'f16', v: 'f16' }

// One shard per (mode x backend), not one per mode sweeping both backends.
// Every other cell in this matrix runs gpu then cpu inside a single shard,
// which is fine for throughput but wrong here: `unload()` leaves mode-dependent
// resident memory behind (measured on desktop), so a cpu load measured after a
// gpu load in the same process reads against a polluted baseline. Twelve shards
// give every backend measurement its own Device Farm session.
const LOAD_MODE_DEVICES = ['gpu', 'cpu']

// Cross-product (size x quant x cache) plus the additive batch and load-mode
// cells.
function matrix() {
  const out = []
  for (const size of SIZES) {
    for (const quant of QUANTS) {
      for (const cache of CACHE_TYPES) {
        out.push({ size, quant, cache })
      }
    }
  }
  for (const size of SIZES) {
    for (const batch of BATCH_SWEEP_SIZES) {
      out.push({ size, quant: BATCH_SWEEP_QUANT, cache: BATCH_SWEEP_CACHE, batch })
    }
  }
  for (const loadMode of LOAD_MODES) {
    for (const loadDevice of LOAD_MODE_DEVICES) {
      out.push({
        size: LOAD_MODE_SIZE,
        quant: LOAD_MODE_QUANT,
        cache: LOAD_MODE_CACHE,
        loadMode,
        loadDevice
      })
    }
  }
  return out
}

// Filename slug: lowercase, drop dots, underscores -> dashes.
// '0.8B' -> '08b', 'Q4_K_M' -> 'q4-k-m', 'q8_0' -> 'q8-0'.
function slug(value) {
  return String(value).toLowerCase().replace(/\./g, '').replace(/_/g, '-')
}

// Single slash-free token identifying a KV-cache type (filesystem and artifact
// safe): the cache type when k === v, else 'k-v'. Used for shard filenames and
// the workflow batch / artifact-suffix name.
function cacheId(cache) {
  return cache.k === cache.v ? cache.k : `${cache.k}-${cache.v}`
}

// Display label for a KV-cache type in report rows: the cache type when
// k === v, else 'k/v', matching the renderer's [kv=...] tag.
function cacheLabel(cache) {
  return cache.k === cache.v ? cache.k : `${cache.k}/${cache.v}`
}

// Trailing '-bs<N>' token for batch-sweep cells; empty for cross-product cells,
// so their filenames, keys and function names are unchanged.
function batchSuffix(cell) {
  return cell.batch !== undefined ? `-bs${cell.batch}` : ''
}

// Trailing '-lm<mode>' token for load-mode cells, with '+' dropped so
// 'mmap+mlock' stays filesystem- and function-name-safe. Empty for every other
// cell, so their filenames and keys are unchanged.
function loadModeSuffix(cell) {
  if (cell.loadMode === undefined) return ''
  const mode = slug(cell.loadMode).replace(/\+/g, '')
  return `-lm${mode}-${cell.loadDevice}`
}

function shardFileName(cell) {
  return `benchmark-perf-${slug(cell.size)}-${slug(cell.quant)}-${slug(cacheId(cell.cache))}${batchSuffix(cell)}${loadModeSuffix(cell)}.test.js`
}

// HuggingFace model id for a cell, e.g. {size:'0.8B',quant:'Q4_0'} -> 'qwen3.5-0.8b-Q4_0'.
// Single source for the id used by the on-device benchmark (modelSpec) and by
// the report renderer's coverage check, so both agree on shard identity.
function modelId(size, quant) {
  return `qwen3.5-${size.toLowerCase()}-${quant}`
}

function modelFileName(size, quant) {
  return `Qwen3.5-${size}-${quant}.gguf`
}

// Stable per-shard key matching the renderer's "[<modelId>] ... [kv=<cache>]
// [bs=<N>]" row label, so coverage can be reconciled against the matrix. The
// '|bs<N>' suffix is present only for batch-sweep cells, so cross-product cells
// keep their existing keys.
function mobileShardKey(cell) {
  const base = `${modelId(cell.size, cell.quant)}|${cacheLabel(cell.cache)}`
  if (cell.batch !== undefined) return `${base}|bs${cell.batch}`
  if (cell.loadMode !== undefined) return `${base}|lm${cell.loadMode}|${cell.loadDevice}`
  return base
}

// Mirrors toFunctionName in scripts/generate-mobile-integration-tests.js:
// split the base name on non-alphanumerics, capitalize each part, prefix run.
function runFunctionName(cell) {
  const base = shardFileName(cell).replace(/\.js$/, '')
  const parts = base.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const suffix = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
  return `run${suffix}`
}

// The exact lines + trailing newline each generated shard file holds. Batch
// cells pass their batch size as the 5th argument; cross-product cells omit it
// so their generated files are byte-identical to before.
function shardContents(cell) {
  const batchArg = cell.batch !== undefined ? `, ${cell.batch}` : ''
  // A load-mode cell passes null for batch so the mode lands in the 6th slot
  // without the two axes ever being crossed, then pins the single backend this
  // shard measures so it gets a process of its own.
  const loadModeArg =
    cell.loadMode !== undefined ? `, null, '${cell.loadMode}', '${cell.loadDevice}'` : ''
  return [
    "'use strict'",
    "const { benchmarkModel } = require('./_benchmark-perf.js')",
    `benchmarkModel('${cell.size}', '${cell.quant}', '${cell.cache.k}', '${cell.cache.v}'${batchArg}${loadModeArg})`,
    ''
  ].join('\n')
}

// Workflow test_groups, one matrix entry per Device Farm batch. Seven entries
// (one per KV-cache type) carry the cross-product's 10 groups each; a
// 'batchsweep' entry carries the additive batch cells (size x batch); a
// 'loadmode' entry carries the six additive load-mode cells. Each additive axis
// runs as its own bounded Device Farm job instead of enlarging a KV batch.
// ---------------------------------------------------------------------------
// The one sweep selector the CI exposes.
//
// Lives here rather than in case-runner.js because both runners need it and
// case-runner.js imports bare-fs, which node cannot load. This module is
// dependency-free, so the bare parameter sweep and the node load-mode
// orchestrator share one parser instead of two that can drift.
// ---------------------------------------------------------------------------

// Main-grid dimensions, plus the two ADDITIVE sweeps. 'load-mode' and
// 'batch-sweep' are not grid axes: each selects a separate sweep that runs at
// its own fixed baseline and is never crossed with the grid (see the README,
// and PR #3300 for the precedent). Naming one runs it; naming none of them
// with a selector present skips them.
const GRID_PARAM_NAMES = [
  'quantization',
  'device',
  'ctx-size',
  'threads',
  'batch-size',
  'ubatch-size',
  'flash-attn',
  'cache-type-k',
  'cache-type-v',
  'reasoning-budget'
]
const ADDITIVE_PARAM_NAMES = ['load-mode', 'batch-sweep']
const SWEEP_PARAM_NAMES = [...GRID_PARAM_NAMES, ...ADDITIVE_PARAM_NAMES]

// Which sweeps a selector turns on. No selector = everything, so the default
// dispatch is unchanged.
// Values that are enumerable up front. Open-ended axes (ctx-size, threads,
// batch sizes) are absent because any positive integer is legitimate; the
// runner rejects a bad one at load time with the engine's own error.
const ALLOWED_VALUES = {
  'load-mode': ['auto', 'none', 'mmap', 'mlock', 'mmap+mlock', 'dio'],
  device: ['gpu', 'cpu'],
  'flash-attn': ['on', 'off', 'enabled', 'disabled', 'true', 'false', '0', '1', 'auto']
}

// Checks the values a selector names, so `load-mode=bogus` fails in the ~30s
// context job rather than surviving to the runner and reading as a mode that
// produced no row.
function validateSweepValues(selected) {
  if (!selected) return
  for (const [name, values] of selected) {
    if (values === null) continue
    const allowed = ALLOWED_VALUES[name]
    if (!allowed) continue
    const bad = values.filter((v) => !allowed.includes(v))
    if (bad.length > 0) {
      throw new Error(`Invalid ${name} value(s): ${bad.join(', ')}. Allowed: ${allowed.join(', ')}`)
    }
  }
}

function sweepSelection(selected) {
  if (!selected) return { grid: true, loadMode: true, batchSweep: true }
  return {
    grid: [...selected.keys()].some((n) => GRID_PARAM_NAMES.includes(n)),
    loadMode: selected.has('load-mode'),
    batchSweep: selected.has('batch-sweep')
  }
}

// Params separate on ',' and values on '|':
//
//   "quantization,cache-type-k"                    sweep both, full range
//   "quantization=Q4_0|Q8_0,load-mode=auto|mmap"   sweep both, listed values
//   "quantization=Q4_0|Q8_0,cache-type-k"          mixed
//
// Two separators are what make "a=1|2,b" unambiguous — with commas on both
// sides there is no way to tell a second value from a second param. '|' is
// safe for every value the sweep accepts, 'mmap+mlock' included.
//
// Returns a Map of param -> values array, or param -> null meaning "sweep this
// dimension's full configured range". Null overall means sweep everything.
function parseSweepParams(text) {
  if (text === null || text === undefined) return null
  const trimmedText = String(text).trim()
  if (trimmedText === '') return null

  const selected = new Map()
  for (const entry of trimmedText.split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    const name = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim()
    if (!SWEEP_PARAM_NAMES.includes(name)) {
      throw new Error(
        `Unknown sweep param "${name}". Known: ${[...SWEEP_PARAM_NAMES].sort().join(', ')}`
      )
    }
    if (eq === -1) {
      selected.set(name, null)
      continue
    }
    const values = trimmed
      .slice(eq + 1)
      .split('|')
      .map((v) => v.trim())
      .filter(Boolean)
    if (values.length === 0) throw new Error(`Sweep param "${name}=" lists no values`)
    selected.set(name, values)
  }
  const result = selected.size > 0 ? selected : null
  validateSweepValues(result)
  return result
}

// Every dimension not named collapses to a single value, so a focused run
// costs only the axes it is about: sweeping quantization alone is 5 cases, not
// 5 x 3 x 2. The collapsed value is the dimension's first configured entry,
// which the sweep already treats as its baseline.
function applySweepParams(sweep, selected) {
  if (!selected) return sweep
  const next = {}
  for (const [key, values] of Object.entries(sweep)) {
    if (!Array.isArray(values)) {
      next[key] = values
      continue
    }
    if (selected.has(key)) {
      const chosen = selected.get(key)
      next[key] = chosen === null ? values.slice() : chosen.slice()
      continue
    }
    next[key] = values.length <= 1 ? values.slice() : [values[0]]
  }
  return next
}

// The proven in-budget load for one Device Farm invocation. Above it Android
// serializes past its time budget and the macOS runner fills its disk
// collecting iOS logs (see benchmark-perf-llm-llamacpp.yml). Any batch this
// planner emits is chunked to stay at or under it — the load-mode axis alone
// is 12 cells, which would have exceeded it as a single batch.
const MAX_SHARDS_PER_BATCH = 10

// Which Device Farm batch a cell belongs to. Cross-product cells batch by
// KV-cache type (10 each); each additive axis gets its own, and load-mode
// splits by backend so neither half exceeds the limit.
function batchKeyOf(cell) {
  if (cell.batch !== undefined) return 'batchsweep'
  if (cell.loadMode !== undefined) return `loadmode-${cell.loadDevice}`
  return cacheId(cell.cache)
}

// Selects cases from the canonical matrix and groups them into safe batches.
//
// A FILTER over cases that exist, never a generator of new ones: the matrix is
// the single source of every available mobile case, and a selection matching
// nothing is reported rather than silently producing an empty run. `selected`
// is the Map from parseSweepParams (null = everything).
function planMobileBatches(selected) {
  // Naming an additive axis picks that FAMILY of cases; every other name then
  // filters within it. So "load-mode=auto,device=gpu" is the GPU load-mode
  // cases for auto — not the load-mode sweep plus the whole grid, which is
  // what treating `device` as a grid selector would have cost.
  //
  // With no additive axis named, the grid is the family and the same names
  // filter it. That keeps one vocabulary for both.
  // No selector at all means every family, so the default dispatch is the
  // whole canonical matrix exactly as before.
  const wantsLoadMode = !selected || selected.has('load-mode')
  const wantsBatch = !selected || selected.has('batch-sweep')
  const wantsGrid = !selected || (!selected.has('load-mode') && !selected.has('batch-sweep'))

  // What each family's shards can actually be filtered by. A grid shard runs
  // both backends and both reasoning budgets inside one Device Farm session,
  // so `device` or `reasoning-budget` cannot select a subset of it — and
  // accepting them silently would return the full 70 while looking filtered,
  // which is the failure the planner exists to prevent.
  const FILTERABLE = {
    grid: ['quantization', 'cache-type-k', 'cache-type-v'],
    'load-mode': ['load-mode', 'device', 'quantization'],
    'batch-sweep': ['batch-sweep', 'batch-size', 'quantization']
  }

  if (selected) {
    const families = []
    if (wantsGrid) families.push('grid')
    if (wantsLoadMode) families.push('load-mode')
    if (wantsBatch) families.push('batch-sweep')
    for (const name of selected.keys()) {
      const usable = families.some((f) => FILTERABLE[f].includes(name))
      if (!usable) {
        throw new Error(
          `"${name}" cannot narrow the mobile ${families.join(' / ')} shards: each shard runs ` +
            `that axis internally, so selecting a value would not reduce what runs. ` +
            `Filterable here: ${[...new Set(families.flatMap((f) => FILTERABLE[f]))].join(', ')}.`
        )
      }
    }
  }

  const matchesValue = (name, value) => {
    if (!selected || !selected.has(name)) return true
    const values = selected.get(name)
    return values === null || values.includes(String(value))
  }

  const cells = matrix().filter((cell) => {
    const isLoadMode = cell.loadMode !== undefined
    const isBatch = cell.batch !== undefined

    if (isLoadMode) {
      return (
        wantsLoadMode &&
        matchesValue('load-mode', cell.loadMode) &&
        matchesValue('device', cell.loadDevice) &&
        matchesValue('quantization', cell.quant)
      )
    }
    if (isBatch) {
      return (
        wantsBatch &&
        matchesValue('quantization', cell.quant) &&
        matchesValue('batch-size', cell.batch)
      )
    }
    return (
      wantsGrid &&
      matchesValue('quantization', cell.quant) &&
      matchesValue('cache-type-k', cell.cache.k) &&
      matchesValue('cache-type-v', cell.cache.v)
    )
  })

  // A selection that matches nothing is a mistake worth surfacing, not an
  // empty run: mobile defines load-mode cases at one quantization only, so
  // "load-mode,quantization=Q8_0" has no shards and must say so rather than
  // silently falling back or dispatching nothing.
  if (selected && cells.length === 0) {
    throw new Error(
      'No mobile benchmark cases match this selection. The matrix defines ' +
        'load-mode cases only at ' +
        LOAD_MODE_QUANT +
        '/' +
        cacheId(LOAD_MODE_CACHE) +
        '; widen the selection or add shards to _benchmark-matrix.js.'
    )
  }

  const byKey = new Map()
  for (const cell of cells) {
    const key = batchKeyOf(cell)
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(cell)
  }

  const batches = []
  for (const [key, group] of byKey) {
    for (let i = 0; i < group.length; i += MAX_SHARDS_PER_BATCH) {
      const chunk = group.slice(i, i + MAX_SHARDS_PER_BATCH)
      const suffix =
        group.length > MAX_SHARDS_PER_BATCH ? `-${Math.floor(i / MAX_SHARDS_PER_BATCH) + 1}` : ''
      batches.push({
        cache: `${key}${suffix}`,
        groups: chunk.map((cell) => {
          const grep = runFunctionName(cell)
          return { name: grep.slice(3).replace(/Test$/, ''), grep }
        })
      })
    }
  }
  return batches
}

// The committed workflow override: the full canonical plan. Kept as a thin
// alias so the planner is the single definition and the two cannot drift.
function workflowBatches() {
  return planMobileBatches(null)
}

module.exports = {
  SIZES,
  QUANTS,
  CACHE_TYPES,
  LOAD_MODES,
  matrix,
  slug,
  cacheId,
  cacheLabel,
  shardFileName,
  modelId,
  modelFileName,
  mobileShardKey,
  runFunctionName,
  planMobileBatches,
  MAX_SHARDS_PER_BATCH,
  parseSweepParams,
  applySweepParams,
  sweepSelection,
  validateSweepValues,
  SWEEP_PARAM_NAMES,
  GRID_PARAM_NAMES,
  ADDITIVE_PARAM_NAMES,
  shardContents,
  workflowBatches
}
