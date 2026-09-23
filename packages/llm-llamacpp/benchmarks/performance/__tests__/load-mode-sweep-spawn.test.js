'use strict'

// Regression tests for run 35778027044, where the darwin-x64 and linux-arm64
// legs each reported SUCCESS while producing 0 of 18 measurements.
//
// Three separate defects lined up to make that look like a clean run:
//   1. the probe was spawned as bare `bare`, absent from those two runners;
//   2. spawn-level errors (ENOENT) were dropped from the failure message,
//      because only result.stderr was read — which is undefined for ENOENT —
//      so every cell read `probe produced no result (exit null): `;
//   3. a leg where nothing loaded still exited 0.
//
// Each test below fails if its fix is reverted.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const Module = require('node:module')

const RUNNER = path.resolve(__dirname, '..', 'load-mode-sweep.js')
const SRC = fs.readFileSync(RUNNER, 'utf8')

// The runner calls main() on require, so compile it without the entry point.
function loadRunner(exportList) {
  const wrapped =
    SRC.replace(/\nmain\(\)[\s\S]*$/, '\n') + `\nmodule.exports = { ${exportList} }\n`
  const mod = new Module('load-mode-sweep-spawn-under-test')
  mod.paths = Module._nodeModulePaths(path.dirname(RUNNER))
  mod.filename = RUNNER
  mod._compile(wrapped, RUNNER)
  return mod.exports
}

test('a missing `bare` falls back to npx rather than failing every cell', () => {
  const { bareCommand } = loadRunner('bareCommand')
  const realPath = process.env.PATH
  try {
    process.env.PATH = '/nonexistent'
    assert.deepStrictEqual(
      bareCommand(),
      ['npx', '--yes', 'bare'],
      'with bare off PATH the runner must fall back to the invocation the workflow already uses'
    )
  } finally {
    process.env.PATH = realPath
  }
})

test('bare on PATH is used directly, and the choice is resolved once', () => {
  const { bareCommand } = loadRunner('bareCommand')
  const probe = spawnSync('bare', ['--version'], { encoding: 'utf8' })
  if (probe.error) return // no bare here; the fallback test above covers this host
  assert.deepStrictEqual(bareCommand(), ['bare'])
  const realPath = process.env.PATH
  try {
    // Memoised: a later PATH change must not re-resolve mid-sweep.
    process.env.PATH = '/nonexistent'
    assert.deepStrictEqual(bareCommand(), ['bare'], 'bareCommand must resolve once, not per probe')
  } finally {
    process.env.PATH = realPath
  }
})

test('a spawn-level failure names its cause instead of a blank tail', () => {
  const { runProbe } = loadRunner('runProbe')
  const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lm-spawn-'))
  const realPath = process.env.PATH
  try {
    process.env.PATH = '/nonexistent'
    // npx is unreachable too, so this exercises the real spawn-failure path.
    const result = runProbe('/tmp/model.gguf', {}, 'local', tmpDir, 'case')
    assert.strictEqual(result.ok, false)
    assert.match(
      result.error,
      /ENOENT/,
      `the failure must name the spawn error; got ${JSON.stringify(result.error)}`
    )
  } finally {
    process.env.PATH = realPath
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('a record is usable only if it measured the device it asked for', () => {
  const { isUsableRecord } = loadRunner('isUsableRecord')
  const good = { status: 'measured', loadMsMedian: 700, requestedDevice: 'gpu', backendDevice: 'gpu' }
  assert.strictEqual(isUsableRecord(good), true)
  assert.strictEqual(
    isUsableRecord({ ...good, status: 'failed' }),
    false,
    'a failed probe is not a measurement'
  )
  assert.strictEqual(
    isUsableRecord({ ...good, loadMsMedian: null }),
    false,
    'a record with no load time is not a measurement'
  )
  assert.strictEqual(
    isUsableRecord({ ...good, backendDevice: 'cpu' }),
    false,
    'a GPU cell that silently ran on CPU is the row the renderer calls non-comparable'
  )
})

test('a leg is no-data when every cell failed, and when every cell fell back', () => {
  const { isUsableRecord } = loadRunner('isUsableRecord')
  const allFailed = Array.from({ length: 18 }, () => ({
    status: 'failed', loadMsMedian: null, requestedDevice: 'cpu', backendDevice: null
  }))
  assert.strictEqual(allFailed.filter(isUsableRecord).length, 0, 'darwin-x64 / linux-arm64 shape')

  // The subtler one: every probe succeeded, but the whole leg ran on a backend
  // nobody asked for. Counting these would let it report success on no data.
  const allMismatched = Array.from({ length: 18 }, () => ({
    status: 'measured', loadMsMedian: 700, requestedDevice: 'gpu', backendDevice: 'cpu'
  }))
  assert.strictEqual(allMismatched.filter(isUsableRecord).length, 0, 'silent CPU fallback is not data')

  const mixed = [...allFailed, { status: 'measured', loadMsMedian: 700, requestedDevice: 'gpu', backendDevice: 'gpu' }]
  assert.strictEqual(mixed.filter(isUsableRecord).length, 1, 'one real cell is enough to be data')
})

test('main() gates its exit code on the usable-record predicate', () => {
  // Behaviour above; this only pins that the guard consults the predicate
  // rather than re-deriving a looser rule inline.
  assert.match(SRC, /const measured = records\.filter\(isUsableRecord\)/)
  assert.match(SRC, /if \(measured\.length === 0\) \{[\s\S]*?process\.exitCode = 1/)
})

test('a cell that ran on a different backend is classified, not counted as measured', () => {
  const { classify, isUsableRecord } = loadRunner('classify, isUsableRecord')
  const samples = [700, 710, 705]

  assert.strictEqual(classify({ device: 'gpu', mode: 'auto' }, samples, 'gpu'), 'measured')
  assert.strictEqual(
    classify({ device: 'gpu', mode: 'auto' }, samples, 'cpu'),
    'backend-mismatch',
    'a GPU request served by the CPU is not a GPU measurement'
  )
  // Mismatch outranks the dio alias: knowing it ran on the wrong device
  // matters more than knowing the flag is inert.
  assert.strictEqual(classify({ device: 'gpu', mode: 'dio' }, samples, 'cpu'), 'backend-mismatch')
  assert.strictEqual(classify({ device: 'gpu', mode: 'dio' }, samples, 'gpu'), 'inert')
  // An unknown backend is not evidence of a mismatch.
  assert.strictEqual(classify({ device: 'gpu', mode: 'auto' }, samples, null), 'measured')

  assert.strictEqual(
    isUsableRecord({ status: 'backend-mismatch', loadMsMedian: 700, requestedDevice: 'gpu', backendDevice: 'cpu' }),
    false,
    'a mismatched cell must not satisfy the no-data guard'
  )
})
