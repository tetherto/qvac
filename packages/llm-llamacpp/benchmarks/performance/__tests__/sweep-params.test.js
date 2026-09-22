'use strict'

// The single CI selector: which dimensions to sweep, optionally with the
// values to sweep them over. Everything not named collapses to one value so a
// focused run does not pay for axes it is not about.

const { test } = require('node:test')
const assert = require('node:assert')
const { parseSweepParams, applySweepParams } = require('../load-mode-sweep.config.js')

// case-runner.js imports bare-fs and cannot load under node; the selector it
// uses lives in the dependency-free config module, which is what this exercises.
const buildSweepFromArgs = (base, args) =>
  applySweepParams(base, parseSweepParams(args['sweep-params']))

// A stand-in for PARAMETER_SWEEP with three multi-valued axes and one pinned.
const BASE = {
  quantization: ['Q4_0', 'Q4_1', 'Q4_K_M'],
  'cache-type-k': ['f16', 'q8_0'],
  'reasoning-budget': ['-1', '0'],
  'ctx-size': ['2048']
}

const combos = (s) =>
  Object.values(s).reduce((n, v) => n * (Array.isArray(v) ? v.length : 1), 1)

test('no selector sweeps everything, unchanged', () => {
  const s = buildSweepFromArgs(BASE, {})
  assert.deepStrictEqual(s, BASE)
  assert.strictEqual(combos(s), 12)
})

test('bare names sweep those axes in full and collapse the rest', () => {
  const s = buildSweepFromArgs(BASE, { 'sweep-params': 'quantization' })
  assert.deepStrictEqual(s.quantization, ['Q4_0', 'Q4_1', 'Q4_K_M'], 'kept in full')
  assert.deepStrictEqual(s['cache-type-k'], ['f16'], 'collapsed to its first value')
  assert.deepStrictEqual(s['reasoning-budget'], ['-1'], 'collapsed to its first value')
  assert.strictEqual(combos(s), 3, '3 cases, not 12')
})

test('several bare names are comma-separated', () => {
  const s = buildSweepFromArgs(BASE, { 'sweep-params': 'quantization,cache-type-k' })
  assert.strictEqual(s.quantization.length, 3)
  assert.strictEqual(s['cache-type-k'].length, 2)
  assert.deepStrictEqual(s['reasoning-budget'], ['-1'])
  assert.strictEqual(combos(s), 6)
})

test('a name can carry the values to sweep it over', () => {
  const s = buildSweepFromArgs(BASE, { 'sweep-params': 'quantization=Q4_0|Q8_0' })
  assert.deepStrictEqual(s.quantization, ['Q4_0', 'Q8_0'], 'uses the listed values')
  assert.deepStrictEqual(s['cache-type-k'], ['f16'], 'others still collapse')
  assert.strictEqual(combos(s), 2)
})

// Params separate on ',' and values on '|' — two separators are what make
// "a=1|2,b" unambiguous.
test('several valued entries are comma-separated', () => {
  const s = buildSweepFromArgs(BASE, {
    'sweep-params': 'quantization=Q4_0|Q8_0,reasoning-budget=0'
  })
  assert.deepStrictEqual(s.quantization, ['Q4_0', 'Q8_0'])
  assert.deepStrictEqual(s['reasoning-budget'], ['0'])
  assert.deepStrictEqual(s['cache-type-k'], ['f16'])
  assert.strictEqual(combos(s), 2)
})

test('valued and bare entries mix', () => {
  const s = buildSweepFromArgs(BASE, {
    'sweep-params': 'quantization=Q4_0|Q8_0,cache-type-k'
  })
  assert.deepStrictEqual(s.quantization, ['Q4_0', 'Q8_0'], 'pinned values')
  assert.deepStrictEqual(s['cache-type-k'], ['f16', 'q8_0'], 'bare name keeps full range')
  assert.strictEqual(combos(s), 4)
})

test('an already-single-valued axis is left alone', () => {
  const s = buildSweepFromArgs(BASE, { 'sweep-params': 'quantization' })
  assert.deepStrictEqual(s['ctx-size'], ['2048'])
})

test('load-mode is a valid selector name', () => {
  // It drives the additive load-mode sweep rather than the main grid, so it
  // must parse without error and must not invent a main-grid dimension.
  const s = buildSweepFromArgs(BASE, { 'sweep-params': 'load-mode=auto|mmap' })
  assert.ok(!('load-mode' in s), 'not added to the main grid')
  assert.deepStrictEqual(s.quantization, ['Q4_0'], 'main grid collapses to baseline')
})

test('an unknown name fails loudly rather than being ignored', () => {
  assert.throws(
    () => buildSweepFromArgs(BASE, { 'sweep-params': 'quantisation' }),
    /Unknown sweep param "quantisation"/,
    'a typo must not silently sweep nothing'
  )
})

test('an empty value list is rejected', () => {
  assert.throws(
    () => buildSweepFromArgs(BASE, { 'sweep-params': 'quantization=,cache-type-k' }),
    /lists no values/
  )
})

test('an empty selector means sweep everything — the default dispatch', () => {
  assert.deepStrictEqual(buildSweepFromArgs(BASE, { 'sweep-params': '' }), BASE)
  assert.deepStrictEqual(buildSweepFromArgs(BASE, { 'sweep-params': undefined }), BASE)
  assert.deepStrictEqual(buildSweepFromArgs(BASE, {}), BASE)
})

test('whitespace around names and values is tolerated', () => {
  const s = buildSweepFromArgs(BASE, {
    'sweep-params': ' quantization = Q4_0 | Q8_0 , cache-type-k '
  })
  assert.deepStrictEqual(s.quantization, ['Q4_0', 'Q8_0'])
  assert.deepStrictEqual(s['cache-type-k'], ['f16', 'q8_0'])
})
