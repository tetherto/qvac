'use strict'

// Direct tests of planMobileBatches — the function the workflow's mobile
// matrix is built from.
//
// The earlier selection tests used a stand-in planner over a sample grid, so
// they proved the selector's arithmetic but never that the real plan contains
// the right shards. These assert exact shard keys against the canonical
// matrix, which is what the Device Farm job actually dispatches.

const { test } = require('node:test')
const assert = require('node:assert')
const {
  planMobileBatches,
  parseSweepParams,
  matrix,
  mobileShardKey,
  runFunctionName,
  MAX_SHARDS_PER_BATCH
} = require('../../../test/integration/_benchmark-matrix.js')

const plan = (sel) => planMobileBatches(parseSweepParams(sel))
const shardsOf = (p) => p.flatMap((b) => b.groups.map((g) => g.grep))
const keysOf = (p) => {
  const planned = new Set(shardsOf(p))
  return matrix()
    .filter((cell) => planned.has(runFunctionName(cell)))
    .map(mobileShardKey)
}

test('empty selection plans the entire canonical matrix', () => {
  const p = plan('')
  assert.strictEqual(shardsOf(p).length, matrix().length, 'every case is planned')
  assert.strictEqual(p.length, 10, '10 batches')
  // Nothing may be lost or duplicated between matrix and plan.
  assert.deepStrictEqual(
    [...shardsOf(p)].sort(),
    matrix().map(runFunctionName).sort()
  )
})

test('no planned batch exceeds the proven Device Farm load', () => {
  for (const sel of ['', 'load-mode', 'batch-sweep', 'quantization=Q4_0']) {
    for (const batch of plan(sel)) {
      assert.ok(
        batch.groups.length <= MAX_SHARDS_PER_BATCH,
        `"${sel}" batch ${batch.cache} has ${batch.groups.length} shards`
      )
      assert.ok(batch.groups.length > 0, `"${sel}" batch ${batch.cache} is empty`)
    }
  }
})

test('load-mode plans exactly the twelve load-mode shards, split by backend', () => {
  const p = plan('load-mode')
  assert.deepStrictEqual(p.map((b) => b.cache), ['loadmode-gpu', 'loadmode-cpu'])
  assert.deepStrictEqual(p.map((b) => b.groups.length), [6, 6], 'six each, under the limit')
  assert.deepStrictEqual(keysOf(p).sort(), [
    'qwen3.5-0.8b-Q4_0|f16|lmauto|cpu',
    'qwen3.5-0.8b-Q4_0|f16|lmauto|gpu',
    'qwen3.5-0.8b-Q4_0|f16|lmdio|cpu',
    'qwen3.5-0.8b-Q4_0|f16|lmdio|gpu',
    'qwen3.5-0.8b-Q4_0|f16|lmmlock|cpu',
    'qwen3.5-0.8b-Q4_0|f16|lmmlock|gpu',
    'qwen3.5-0.8b-Q4_0|f16|lmmmap+mlock|cpu',
    'qwen3.5-0.8b-Q4_0|f16|lmmmap+mlock|gpu',
    'qwen3.5-0.8b-Q4_0|f16|lmmmap|cpu',
    'qwen3.5-0.8b-Q4_0|f16|lmmmap|gpu',
    'qwen3.5-0.8b-Q4_0|f16|lmnone|cpu',
    'qwen3.5-0.8b-Q4_0|f16|lmnone|gpu'
  ])
})

test('a mode and backend selection plans exactly those shard keys', () => {
  assert.deepStrictEqual(keysOf(plan('load-mode=auto|mmap,device=gpu')).sort(), [
    'qwen3.5-0.8b-Q4_0|f16|lmauto|gpu',
    'qwen3.5-0.8b-Q4_0|f16|lmmmap|gpu'
  ])
  assert.deepStrictEqual(keysOf(plan('load-mode=dio,device=cpu')), [
    'qwen3.5-0.8b-Q4_0|f16|lmdio|cpu'
  ])
})

test('batch-size narrows the additive batch sweep', () => {
  const keys = keysOf(plan('batch-sweep,batch-size=512'))
  assert.strictEqual(keys.length, 2, 'both sizes at bs=512, not all four cells')
  assert.ok(keys.every((k) => k.endsWith('|bs512')), keys.join(' '))
})

// An axis each shard runs internally cannot narrow that shard. Accepting it
// silently returned the full set while looking filtered — the exact failure
// the planner exists to prevent.
test('an axis the shards run internally is rejected, not ignored', () => {
  assert.throws(() => plan('device=gpu'), /cannot narrow the mobile grid shards/)
  assert.throws(() => plan('threads=8'), /cannot narrow the mobile grid shards/)
  assert.throws(() => plan('load-mode,reasoning-budget=0'), /cannot narrow the mobile/)
})

test('a selection matching no canonical case fails clearly', () => {
  // Mobile defines load-mode cases at Q4_0 only.
  assert.throws(
    () => plan('load-mode,quantization=Q8_0'),
    /No mobile benchmark cases match this selection/
  )
})

test('every planned shard exists in the matrix and appears once', () => {
  for (const sel of ['', 'load-mode', 'load-mode=auto', 'batch-sweep', 'quantization=Q4_0|Q8_0']) {
    const shards = shardsOf(plan(sel))
    const canonical = new Set(matrix().map(runFunctionName))
    for (const s of shards) assert.ok(canonical.has(s), `${s} not in matrix (selector "${sel}")`)
    assert.strictEqual(new Set(shards).size, shards.length, `duplicate shard for "${sel}"`)
  }
})

// run-meta stamps the coverage target; the mobile job dispatches the plan.
// If they diverge, the report scores a run that did not happen.
test('run-meta expectations equal the shards actually dispatched', () => {
  for (const sel of ['', 'load-mode', 'load-mode=auto|mmap,device=gpu']) {
    const p = plan(sel)
    const dispatched = new Set(shardsOf(p))
    const stamped = matrix()
      .filter((cell) => dispatched.has(runFunctionName(cell)))
      .map(mobileShardKey)
    assert.strictEqual(stamped.length, dispatched.size, `"${sel}" stamp/dispatch size mismatch`)
    assert.deepStrictEqual(stamped.sort(), keysOf(p).sort(), `"${sel}" stamp/dispatch differ`)
  }
})
