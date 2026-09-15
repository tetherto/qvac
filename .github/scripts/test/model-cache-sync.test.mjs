import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SCRIPT = '.github/scripts/validate-model-cache-sync.mjs'

const run = (cwd) => spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' })

// Copy just enough of the repo for the validator to run against a mutated tree.
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'model-cache-sync-'))
  for (const p of ['.github/workflows', '.github/scripts/lib', '.github/scripts']) {
    cpSync(join(root, p), join(dir, p), { recursive: true })
  }
  return dir
}

test('the repository is in sync: every seed identity has a consumer', () => {
  const r = run(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /all consumed/)
})

// Ian's scenario: bump cache-version on the consumer only. Nothing else goes
// red -- the seed still saves and its verify job asserts the same stale key.
test('fails when a consumer bumps cache-version and the seed does not', () => {
  const dir = sandbox()
  try {
    const f = join(dir, '.github/workflows/integration-test-diffusion-cpp.yml')
    const before = readFileSync(f, 'utf8')
    const after = before.replace(/cache-version: v2/g, 'cache-version: v3')
    assert.notEqual(after, before, 'fixture no longer contains cache-version: v2')
    writeFileSync(f, after)

    const r = run(dir)
    assert.equal(r.status, 1, 'validator should fail')
    assert.match(r.stderr, /seed identity\(ies\) nothing consumes/)
    assert.match(r.stderr, /on-merge-model-cache-diffusion\.yml/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fails when a consumer changes its cached paths and the seed does not', () => {
  const dir = sandbox()
  try {
    const f = join(dir, '.github/workflows/integration-test-tts-ggml.yml')
    const before = readFileSync(f, 'utf8')
    // tts has no seed today, so use a seeded package: move translation's paths.
    const g = join(dir, '.github/workflows/integration-test-translation-nmtcpp.yml')
    const gb = readFileSync(g, 'utf8')
    const ga = gb.replace(
      'paths: packages/translation-nmtcpp/model',
      'paths: packages/translation-nmtcpp/model-v2',
    )
    assert.notEqual(ga, gb, 'fixture no longer contains the translation paths input')
    writeFileSync(g, ga)
    assert.equal(readFileSync(f, 'utf8'), before)

    const r = run(dir)
    assert.equal(r.status, 1, 'validator should fail')
    assert.match(r.stderr, /on-merge-model-cache-translation\.yml/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a suffix that is a prefix of another is still a distinct identity', () => {
  const dir = sandbox()
  try {
    const f = join(dir, '.github/workflows/integration-test-audiogen-ggml.yml')
    const before = readFileSync(f, 'utf8')
    // revert the turbo-q4 fix: the functional leg goes back to an empty suffix
    const after = before.replace(
      "inputs.run_rtf_benchmarks && 'all-dit-variants' || 'turbo-q4'",
      "inputs.run_rtf_benchmarks && 'all-dit-variants' || ''",
    )
    assert.notEqual(after, before, 'fixture no longer contains the turbo-q4 suffix')
    writeFileSync(f, after)

    const r = run(dir)
    assert.equal(r.status, 1, 'seed writing turbo-q4 should no longer match any consumer')
    assert.match(r.stderr, /on-merge-model-cache-audiogen\.yml/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
