'use strict'

// What each selector actually PRODUCES — grid cases, additive sweeps, mobile
// batches — not just how the string parses.
//
// The parser tests passed while the documented behaviour was false: the README
// claimed "load-mode=auto|mmap,quantization" measured those modes across every
// quantization, when the two sweeps are additive and never crossed. Asserting
// the produced case set is what catches that class of mistake.

const { test } = require('node:test')
const assert = require('node:assert')
const {
  parseSweepParams,
  applySweepParams,
  sweepSelection,
  buildLoadModeCells,
  createLoadModeSweep,
  applyCliOverrides
} = require('../load-mode-sweep.config.js')

const GRID = {
  quantization: ['Q4_0', 'Q4_1', 'Q4_K_M'],
  'cache-type-k': ['f16', 'q8_0'],
  'reasoning-budget': ['-1', '0']
}

const MODEL = [{ id: 'qwen3.5-0.8b', modelDir: '/m', quantizationFiles: { Q4_0: 'a.gguf', Q8_0: 'b.gguf' } }]

// Mirrors the context job: which sweeps and mobile batches a selector turns on.
const CACHE_BATCHES = ['f16', 'q8_0', 'q4_0', 'tbq3_0-pq3_0', 'tbq4_0-pq4_0', 'pq3_0', 'pq4_0']
function plan(text) {
  const selected = parseSweepParams(text)
  const runs = sweepSelection(selected)
  const grid = applySweepParams(GRID, selected)
  const gridCases = runs.grid
    ? Object.values(grid).reduce((n, v) => n * v.length, 1)
    : 0
  const lmSweep = applyCliOverrides(createLoadModeSweep('linux'), text ? { 'sweep-params': text } : {})
  const loadModeCells = runs.loadMode ? buildLoadModeCells(MODEL, lmSweep).length : 0
  const batches = [
    ...(runs.grid ? CACHE_BATCHES : []),
    ...(runs.batchSweep ? ['batchsweep'] : []),
    ...(runs.loadMode ? ['loadmode'] : [])
  ]
  return { gridCases, loadModeCells, batchSweep: runs.batchSweep, batches }
}

test('empty selector runs everything — the default dispatch', () => {
  const p = plan('')
  assert.strictEqual(p.gridCases, 12, 'full grid')
  assert.strictEqual(p.loadModeCells, 6, 'all six load modes')
  assert.strictEqual(p.batchSweep, true, 'additive batch sweep runs')
  assert.strictEqual(p.batches.length, 9, 'all mobile batches')
})

test('"load-mode=auto|mmap" runs only those two modes and no grid', () => {
  const p = plan('load-mode=auto|mmap')
  assert.strictEqual(p.gridCases, 0, 'the ~6h grid is skipped entirely')
  assert.strictEqual(p.loadModeCells, 2, 'two modes')
  assert.strictEqual(p.batchSweep, false, 'batch sweep not selected')
  assert.deepStrictEqual(p.batches, ['loadmode'], 'mobile runs one batch, not all nine')
})

test('"quantization" runs the grid only', () => {
  const p = plan('quantization')
  assert.strictEqual(p.gridCases, 3, 'quantization varies; others pinned')
  assert.strictEqual(p.loadModeCells, 0, 'load-mode not selected')
  assert.strictEqual(p.batchSweep, false, 'batch sweep not selected')
  assert.deepStrictEqual(p.batches, CACHE_BATCHES, 'no batchsweep or loadmode batch')
})

// A grid axis named alongside load-mode narrows the load-mode sweep only;
// naming an additive sweep excludes the throughput grid.
test('"load-mode=auto|mmap,quantization=Q4_0|Q8_0" narrows the load-mode sweep, not the grid', () => {
  // A grid axis named alongside an additive sweep narrows THAT sweep. It does
  // not also select the grid: naming load-mode is how a dispatch says it does
  // not want the grid, and a shared axis must not quietly buy it back.
  const p = plan('load-mode=auto|mmap,quantization=Q4_0|Q8_0')
  assert.strictEqual(p.gridCases, 0, 'the grid is not selected')
  assert.strictEqual(p.loadModeCells, 4, '2 modes x 2 quantizations in the load-mode sweep')
  assert.deepStrictEqual(p.batches, ['loadmode'])
})

test('a bare quantization name sweeps every quantization the model has', () => {
  // MODEL declares Q4_0 and Q8_0; a bare name must not silently fall back to
  // the load-mode sweep's single-quantization default.
  const p = plan('load-mode=auto|mmap,quantization')
  assert.strictEqual(p.loadModeCells, 4, '2 modes x the model\'s 2 quantizations')
})

test('device and ctx-size narrow the load-mode sweep too', () => {
  const p = plan('load-mode=auto,device=gpu|cpu')
  assert.strictEqual(p.loadModeCells, 2, 'one mode across both backends')
})

// What stays additive is the relationship to the main grid: load-mode is its
// own sweep, never multiplied into the 70-cell matrix.
test('load-mode is not crossed into the main grid', () => {
  const p = plan('load-mode,quantization')
  assert.strictEqual(p.gridCases, 0, 'naming load-mode excludes the grid')
  assert.ok(p.loadModeCells < 3 * 6, 'load-mode cells are not gridCases x modes')
})

test('a grid axis named with an additive sweep never starts the grid', () => {
  // The acceptance selector's shape. `device` is a grid axis, so under the
  // old rule this dispatch ran a 45-run throughput grid alongside a
  // minutes-long load-mode sweep — observed on win32-x64 in run 35825109178.
  for (const sel of [
    'load-mode=auto,device=cpu|gpu',
    'load-mode,device=cpu|gpu',
    'batch-sweep,device=gpu',
    'load-mode,ctx-size=2048'
  ]) {
    assert.strictEqual(plan(sel).gridCases, 0, `${sel} must not start the grid`)
  }
  // ...while a selector naming only grid axes still does.
  assert.ok(plan('quantization').gridCases > 0, 'a pure grid selector is unaffected')
  assert.ok(plan('device=gpu').gridCases > 0)
})

test('"batch-sweep" selects the additive batch sweep alone', () => {
  const p = plan('batch-sweep')
  assert.strictEqual(p.batchSweep, true)
  assert.strictEqual(p.gridCases, 0, 'grid skipped')
  assert.strictEqual(p.loadModeCells, 0, 'load-mode skipped')
  assert.deepStrictEqual(p.batches, ['batchsweep'], 'one mobile batch')
})

test('a grid selector does not drag in the additive sweeps', () => {
  // Previously the batch sweep was appended unconditionally, so selecting
  // quantization also paid for an unrelated sweep.
  assert.strictEqual(plan('quantization').batchSweep, false)
  assert.strictEqual(plan('cache-type-k').loadModeCells, 0)
})

test('load-mode named bare keeps all six modes', () => {
  assert.strictEqual(plan('load-mode').loadModeCells, 6)
})

test('every selector still yields a non-empty mobile batch list', () => {
  for (const sel of ['', 'quantization', 'load-mode', 'batch-sweep', 'load-mode,quantization']) {
    assert.ok(plan(sel).batches.length > 0, `"${sel}" selects at least one mobile batch`)
  }
})

test('an explicit device= in the selector outranks --load-mode-device', () => {
  // The workflow passes --load-mode-device on its CPU-only legs. That is a
  // per-leg default, not a decision: a dispatch that names device= must win,
  // or the documented device filtering is a no-op wherever the flag is set.
  const sweep = applyCliOverrides(createLoadModeSweep('linux'), {
    'sweep-params': 'load-mode=auto,device=gpu',
    'load-mode-device': 'cpu'
  })
  assert.deepStrictEqual(sweep.device, ['gpu'], 'selector device must beat the flag')
})

test('--load-mode-device still applies when the selector is silent about device', () => {
  const sweep = applyCliOverrides(createLoadModeSweep('linux'), {
    'sweep-params': 'load-mode=auto',
    'load-mode-device': 'cpu'
  })
  assert.deepStrictEqual(sweep.device, ['cpu'], 'the per-leg default still applies')
})

test('the desktop default stays one backend, not both', () => {
  // Measuring both everywhere doubles every leg and asks for a GPU on the
  // deliberately CPU-only runners. Opting in is what device= is for.
  assert.deepStrictEqual(createLoadModeSweep('linux').device, ['gpu'])
  assert.deepStrictEqual(createLoadModeSweep('android').device, ['cpu', 'gpu'])
})

test('the backend-verification generation is capped, all the way to the cell config', () => {
  // The probe generates purely to learn which backend ran. Uncapped, the addon
  // default is unbounded and every sample paid for a full generation on top of
  // the load it existed to measure. Asserting the sweep value alone is not
  // enough: buildLoadModeCells rebuilds config from a fixed field list, and
  // the cap was silently dropped there when it was only added to the sweep.
  const sweep = createLoadModeSweep('linux')
  assert.strictEqual(sweep['n-predict'], '1', 'the sweep pins one token')

  const cells = buildLoadModeCells(
    [{ id: 'm', modelDir: '/m', quantizationFiles: { Q4_0: 'a.gguf' } }],
    sweep
  )
  assert.ok(cells.length > 0)
  for (const cell of cells) {
    assert.strictEqual(
      cell.config['n-predict'],
      '1',
      `${cell.caseId} must carry the cap into the config the probe actually runs`
    )
  }
})

test('the mobile backend probe uses the documented per-request generation key', () => {
  // GenerationParams (index.d.ts) accepts `predict`. The load-time config
  // spelling is `n-predict` / `n_predict`, and using that per request caps
  // nothing and fails silently — the cell then runs a full generation purely
  // to read one field.
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'test', 'integration', '_benchmark-perf.js'),
    'utf8'
  )
  assert.match(src, /generationParams\.predict = nPredict/, 'per-request cap uses `predict`')
  assert.doesNotMatch(
    src,
    /generationParams\.n_predict/,
    'the load-time spelling is not a per-request key'
  )

  const dts = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'index.d.ts'),
    'utf8'
  )
  const block = /interface GenerationParams \{[\s\S]*?\n {4}\}/.exec(dts)
  assert.ok(block, 'GenerationParams is declared')
  assert.match(block[0], /\bpredict\?: number/, 'predict is the declared field')
  assert.doesNotMatch(block[0], /\bn_predict\?/, 'n_predict is not a GenerationParams field')
})
