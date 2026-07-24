'use strict'

// Node unit tests for the matrix generator (scripts/coload-combinations.mjs),
// exercised through its CLI exactly as the workflows invoke it.
// Run with: npm run test:unit  (node --test)

const { test } = require('node:test')
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

const SCRIPT = join(__dirname, '..', 'scripts', 'coload-combinations.mjs')

function run (args) {
  const out = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' })
  return JSON.parse(out)
}

function names (combos) {
  return combos.map(c => c.name)
}

test('full mode always includes the all-addon combo', () => {
  const combos = run([])
  assert.ok(names(combos).includes('all'))
  const all = combos.find(c => c.name === 'all')
  assert.ok(all.addons.split(',').length >= 2)
})

test('changed mode focuses on the changed addon and keeps the all combo', () => {
  const combos = run(['--changed', 'tts-ggml'])
  const changedNames = names(combos)
  assert.ok(changedNames.includes('all'))
  assert.ok(combos.every(c => c.addons.split(',').includes('tts-ggml')))
})

test('changed mode with an unknown addon falls back to the full matrix', () => {
  const combos = run(['--changed', 'not-an-addon'])
  assert.deepStrictEqual(names(combos), names(run([])))
})

test('--only narrows the matrix to the named combos', () => {
  const combos = run(['--only', 'all'])
  assert.deepStrictEqual(names(combos), ['all'])
})

test('--mobile drops combos with fewer than two SDK plugins', () => {
  const combos = run(['--mobile'])
  assert.ok(combos.length > 0)
  for (const c of combos) {
    const plugins = c.plugins.split(',').filter(Boolean)
    assert.ok(plugins.length >= 2, `combo ${c.name} has <2 plugins`)
  }
})
