'use strict'

// Direct tests of the load-mode runner's aggregators.
//
// These exist because the renderer-level test for absent memory counters feeds
// already-null metrics in, which bypasses the place the nulls are actually
// produced. The original bug was here: mean([null, null, null]) returned 0, so
// darwin and win32 — which have no /proc, and therefore no RssAnon, RssFile or
// VmLck — wrote a measured-looking 0 into the report. Reverting the numeric
// filter would not fail a renderer test that never calls this code.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const RUNNER = path.resolve(__dirname, '..', 'load-mode-sweep.js')

// The runner calls main() on require, so compile it without the entry point.
function loadStats() {
  const src = fs.readFileSync(RUNNER, 'utf8')
  const wrapped =
    src.replace(/\nmain\(\)[\s\S]*$/, '\n') + '\nmodule.exports = { mean, median, stddev }\n'
  const mod = new Module('load-mode-sweep-under-test')
  mod.paths = Module._nodeModulePaths(path.dirname(RUNNER))
  mod.filename = RUNNER
  mod._compile(wrapped, RUNNER)
  return mod.exports
}

const { mean, median, stddev } = loadStats()

test('all-null input yields null, not zero', () => {
  // A platform without /proc reports this shape for anon/file/locked.
  assert.strictEqual(mean([null, null, null]), null, 'mean must not average nulls to 0')
  assert.strictEqual(median([null, null, null]), null, 'median must not pick a null')
  assert.strictEqual(stddev([null, null, null]), null, 'stddev must not derive from nulls')
})

test('an empty sample set yields null', () => {
  assert.strictEqual(mean([]), null)
  assert.strictEqual(median([]), null)
  assert.strictEqual(stddev([]), null)
})

test('nulls mixed with numbers are ignored, not counted as zero', () => {
  // Counting the null as 0 would give 5; ignoring it gives 10.
  assert.strictEqual(mean([10, null, 10]), 10)
  assert.strictEqual(median([10, null, 10]), 10)
  // Sorting with a null present must not corrupt the ordering either.
  assert.strictEqual(median([30, null, 10, 20]), 20)
})

test('undefined and NaN are treated as absent', () => {
  assert.strictEqual(mean([undefined, NaN]), null)
  assert.strictEqual(mean([4, undefined, NaN, 6]), 5)
})

test('numeric aggregation is unchanged for clean input', () => {
  assert.strictEqual(mean([1, 2, 3]), 2)
  assert.strictEqual(median([3, 1, 2]), 2)
  assert.strictEqual(median([4, 1, 2, 3]), 2.5)
  assert.strictEqual(stddev([2, 2, 2]), 0)
  assert.ok(stddev([1, 2, 3]) > 0)
})

test('a single sample has zero spread, not null', () => {
  // Distinguishes "one measurement, no spread" from "no measurements".
  assert.strictEqual(stddev([42]), 0)
  assert.strictEqual(mean([42]), 42)
})
