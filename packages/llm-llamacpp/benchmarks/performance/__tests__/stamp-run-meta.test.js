'use strict'

// stamp-run-meta.js writes the run-meta.json the report's coverage is scored
// against. It used to be an inline `node -e "..."` whose comment contained a
// double quote: the shell string ended there, node ran a truncated script,
// wrote nothing, and every dispatch failed in stamp-version. These tests run
// the script the way the workflow does — as a process, from a working
// directory, driven by the same env — and check what it wrote.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..')
const SCRIPT = path.join(REPO, '.github', 'scripts', 'stamp-run-meta.js')
const LOAD_MODES = ['auto', 'none', 'mmap', 'mlock', 'mmap+mlock', 'dio']

function stamp(env) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'run-meta-'))
  try {
    execFileSync(process.execPath, [SCRIPT], {
      cwd,
      env: { ...process.env, SWEEP_PARAMS: '', RUN_MOBILE: 'false', ...env }
    })
    return JSON.parse(fs.readFileSync(path.join(cwd, 'run-meta', 'run-meta.json'), 'utf8'))
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

test('the acceptance dispatch stamps its twelve mobile shards and every mode', () => {
  const meta = stamp({ SWEEP_PARAMS: 'load-mode,device=cpu|gpu', RUN_MOBILE: 'true' })
  const version = require(path.join(REPO, 'packages', 'llm-llamacpp', 'package.json')).version
  assert.strictEqual(meta.addonVersion, `@qvac/llm-llamacpp@${version}`)
  assert.strictEqual(meta.sweepParams, 'load-mode,device=cpu|gpu')
  assert.strictEqual(meta.expectedShards.length, 12, 'six modes on each of cpu and gpu')
  assert.ok(
    meta.expectedShards.every((k) => /\|lm/.test(k)),
    'only load-mode shards are expected'
  )
  assert.deepStrictEqual(meta.selectedLoadModes, LOAD_MODES)
})

test('a desktop-only dispatch expects no mobile shards but still every mode', () => {
  const meta = stamp({ SWEEP_PARAMS: 'load-mode', RUN_MOBILE: 'false' })
  assert.deepStrictEqual(meta.expectedShards, [])
  assert.deepStrictEqual(meta.selectedLoadModes, LOAD_MODES)
})

test('a narrowed selector stamps only the modes it named', () => {
  const meta = stamp({ SWEEP_PARAMS: 'load-mode=auto|mmap', RUN_MOBILE: 'false' })
  assert.deepStrictEqual(meta.selectedLoadModes, ['auto', 'mmap'])
})

test('the default dispatch stamps the whole mobile matrix', () => {
  const meta = stamp({ SWEEP_PARAMS: '', RUN_MOBILE: 'true' })
  assert.ok(meta.expectedShards.length > 12, `got ${meta.expectedShards.length} shards`)
  assert.deepStrictEqual(meta.selectedLoadModes, LOAD_MODES)
})
