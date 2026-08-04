'use strict'

// Node unit tests for the matrix generator (scripts/coload-combinations.mjs),
// exercised through its CLI exactly as the workflows invoke it.
// Run with: npm run test:unit  (node --test)

const { test } = require('node:test')
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { writeFileSync, rmSync } = require('node:fs')

const SCRIPT = join(__dirname, '..', 'scripts', 'coload-combinations.mjs')

function run (args) {
  const out = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' })
  return JSON.parse(out)
}

function runFail (args) {
  try {
    execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' })
  } catch (err) {
    return { status: err.status, stderr: err.stderr }
  }
  assert.fail(`expected \`${args.join(' ')}\` to exit non-zero`)
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

// A matrix over the published addon set never loads an addon that is missing
// from addons.js, so falling back here would gate the PR on a run that cannot
// fail -- green without ever loading the caller's addon.
test('changed mode rejects an explicitly named unknown addon', () => {
  const { status, stderr } = runFail(['--changed', 'not-an-addon'])
  assert.notStrictEqual(status, 0)
  assert.match(stderr, /unknown addon\(s\) not-an-addon/)
})

test('changed mode reports every unknown addon and the known set', () => {
  const { stderr } = runFail(['--changed', 'tts-ggml,nope-one,nope-two'])
  assert.match(stderr, /nope-one/)
  assert.match(stderr, /nope-two/)
  assert.match(stderr, /tts-ggml/)
})

// Diff-derived names are best-effort: a PR touching no addon at all must still
// produce a matrix rather than fail the workflow.
test('changed-files mode still falls back to the full matrix', () => {
  const diff = join(tmpdir(), `coload-diff-${process.pid}.txt`)
  writeFileSync(diff, 'docs/README.md\npackages/not-an-addon/index.js\n')
  try {
    assert.deepStrictEqual(names(run(['--changed-files', diff])), names(run([])))
  } finally {
    rmSync(diff, { force: true })
  }
})

test('--only rejects a name that matches no combination', () => {
  const { status, stderr } = runFail(['--only', 'no-such-combo'])
  assert.notStrictEqual(status, 0)
  assert.match(stderr, /matched no combination/)
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
