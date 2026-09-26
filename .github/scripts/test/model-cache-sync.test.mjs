import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SCRIPT = '.github/scripts/validate-model-cache-sync.mjs'

const run = (cwd) => spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' })

// Enough of the repo for the validator to run against a mutated copy: the
// workflows, the scripts, and every package's project.json (the nx lane's
// cache identities live there).
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'model-cache-sync-'))
  for (const p of ['.github/workflows', '.github/scripts']) {
    cpSync(join(root, p), join(dir, p), { recursive: true })
  }
  for (const pkg of readdirSync(join(root, 'packages'))) {
    const src = join(root, 'packages', pkg, 'project.json')
    try {
      const text = readFileSync(src, 'utf8')
      mkdirSync(join(dir, 'packages', pkg), { recursive: true })
      writeFileSync(join(dir, 'packages', pkg, 'project.json'), text)
    } catch {
      /* package has no project.json */
    }
  }
  return dir
}

const wf = (dir, name) => join(dir, '.github/workflows', name)

function edit(dir, name, from, to) {
  const f = wf(dir, name)
  const before = readFileSync(f, 'utf8')
  const after = before.replace(from, to)
  assert.notEqual(after, before, `fixture stale: ${name} no longer contains ${from}`)
  writeFileSync(f, after)
}

test('the repository is in sync and free of new collisions', () => {
  const r = run(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /all consumed/)
  assert.match(r.stdout, /no NEW restore-key prefix collisions/)
})

// The scenario Ian described: bump cache-version on the consumer only. Nothing
// else goes red -- the seed still saves, and its verify job asserts the same
// stale key, so the seed run stays green while every PR leg misses.
test('fails when a consumer bumps cache-version and the seed does not', () => {
  const dir = sandbox()
  try {
    // Bump the consumer and forget the seed. diffusion-cpp's only consumer is now
    // the nx block in its project.json: integration-test-diffusion-cpp.yml was
    // consolidated into integration-test-nx.yml.
    const pj = join(dir, 'packages/diffusion-cpp/project.json')
    writeFileSync(pj, readFileSync(pj, 'utf8').replaceAll('"cacheVersion": "v2"', '"cacheVersion": "v3"'))
    const r = run(dir)
    assert.equal(r.status, 1, r.stdout)
    assert.match(r.stderr, /seed identity\(ies\) nothing consumes/)
    assert.match(r.stderr, /on-merge-model-cache-diffusion\.yml/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fails when a consumer moves its cached paths and the seed does not', () => {
  const dir = sandbox()
  try {
    // audiogen, not translation: translation appears in KNOWN_COLLISIONS, so
    // moving its paths would trip the unobserved-collision check first.
    edit(
      dir,
      'integration-test-audiogen-ggml.yml',
      'paths: packages/audiogen-ggml/models',
      'paths: packages/audiogen-ggml/models-v2',
    )
    const r = run(dir)
    assert.equal(r.status, 1, r.stdout)
    assert.match(r.stderr, /on-merge-model-cache-audiogen\.yml/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Ian's audiogen bug, on the real workflow: reverting the turbo-q4 suffix puts
// an empty suffix back, whose restore prefix reaches the all-dit-variants key.
test('rejects the audiogen collision the turbo-q4 suffix fixed', () => {
  const dir = sandbox()
  try {
    edit(
      dir,
      'integration-test-audiogen-ggml.yml',
      "inputs.run_rtf_benchmarks && 'all-dit-variants' || 'turbo-q4'",
      "inputs.run_rtf_benchmarks && 'all-dit-variants' || ''",
    )
    const r = run(dir)
    assert.equal(r.status, 1, r.stdout)
    assert.match(r.stderr, /restore-key prefix collision/)
    assert.match(r.stderr, /suffix \(empty\) reaches suffix all-dit-variants/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Same hazard between two DIFFERENT call sites in one cache version, which the
// first version of this check could not see: it keyed on suffix alone, so two
// sites sharing a suffix collapsed, and it wrongly treated hash-files-glob as
// part of the cache version.
test('rejects a collision between two distinct consumer call sites', () => {
  const dir = sandbox()
  try {
    // diffusion-cpp's call sites are now the nx modelCache blocks in its
    // project.json, so this mutates those instead of the deleted
    // integration-test-diffusion-cpp.yml. Same shape as before: move ltx under
    // base's group so the two share a cache version, and give it a suffix that
    // base's restore prefix reaches. Renaming the group too is required, since
    // versionOf() includes group and entries in different groups never compare.
    const pj = join(dir, 'packages/diffusion-cpp/project.json')
    writeFileSync(
      pj,
      readFileSync(pj, 'utf8')
        .replaceAll('"cacheKeySuffix": "ltx"', '"cacheKeySuffix": "base-extra"')
        .replaceAll('"group": "ltx"', '"group": "base"'),
    )
    const r = run(dir)
    assert.equal(r.status, 1, r.stdout)
    assert.match(r.stderr, /restore-key prefix collision/)
    assert.match(r.stderr, /suffix base reaches suffix base-extra/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The amnesty list must pardon exactly the recorded pairs, not a whole file.
test('a NEW collision in an allowlisted file still fails', () => {
  const dir = sandbox()
  try {
    const f = wf(dir, 'cpp-test-coverage-asr-ggml.yml')
    const src = readFileSync(f, 'utf8')
    // a second asr call site with a different glob: same class, not recorded
    const extra = src.replace(
      'cache-key-suffix: cpp-tests',
      'cache-key-suffix: cpp-tests-extra',
    )
    assert.notEqual(extra, src, 'fixture stale')
    writeFileSync(f, extra)
    const r = run(dir)
    assert.equal(r.status, 1, r.stdout)
    assert.match(r.stderr, /restore-key prefix collision|no longer observed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// If a parser regression drops one of a call site's inputs, that site changes
// version bucket and its recorded collision stops firing -- silently, and the
// same regression would hide a NEW collision just as well.
test('fails when a recorded collision stops being observed', () => {
  const dir = sandbox()
  try {
    edit(dir, 'cpp-test-coverage-asr-ggml.yml', /^ +paths: packages\/asr-ggml\/models$/m, '')
    const r = run(dir)
    assert.equal(r.status, 1, r.stdout)
    assert.match(r.stderr, /no longer observed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Every other check reads the parser's output, so a parser that quietly stops
// finding call sites would make all of them pass on an empty set.
test('fails closed when a call site stops being parsed', () => {
  const dir = sandbox()
  try {
    edit(
      dir,
      'on-merge-model-cache-llm.yml',
      /uses: \.\/\.github\/actions\/cache-models$/gm,
      'uses: ./.github/actions/cache-models # shared',
    )
    const r = run(dir)
    assert.equal(r.status, 1, r.stdout)
    assert.match(r.stderr, /parser has gone blind/)
    assert.match(r.stderr, /on-merge-model-cache-llm\.yml/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fails closed when the nx consumer blocks disappear', () => {
  const dir = sandbox()
  try {
    rmSync(join(dir, 'packages'), { recursive: true, force: true })
    const r = run(dir)
    assert.equal(r.status, 1, r.stdout)
    assert.match(r.stderr, /nx modelCache blocks parsed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
