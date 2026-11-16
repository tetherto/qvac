import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// on-pr-nx and Merge Guard run on pull_request_target, so their package
// selection comes from the base branch, where a package the PR deletes still
// exists. Without dropping it, its jobs run in a directory the PR head no
// longer has and both merge guards fail (PR #5775, removing model-fit).
// Both workflows load from the base branch, so these tests are the only
// pre-merge check on a change to this logic.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const action = readFileSync(join(root, '.github/actions/nx-project-matrix/action.yml'), 'utf8')
const guard = readFileSync(join(root, '.github/workflows/pr-gate-merge.yml'), 'utf8')

const matrixSelector = action.match(/jq -r '(if \.status == "removed"[^']*)' "\$files"/)?.[1]
const guardSelector = guard.match(/--jq '\.\[\] \| (if \.status == "removed"[^']*)'/)?.[1]
const allPackages = guard.match(/ALL_PACKAGES: '(\[[^\n]*\])'/)?.[1]

// The `run: |` body of the step whose header line contains `marker`, dedented.
function runBlock(source, marker) {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.includes(marker))
  const run = lines.findIndex((line, i) => i > start && /^\s+run: \|$/.test(line))
  assert.ok(start >= 0 && run > start, `no run block after "${marker}"`)
  const indent = lines[run].search(/\S/) + 2
  const body = []
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && line.search(/\S/) < indent) break
    body.push(line.slice(indent))
  }
  return body.join('\n')
}

// From the DELETED_FILE assignment to the `fi` closing its `if`.
function subtractionBlock() {
  const lines = runBlock(action, '- id: compute').split('\n')
  const start = lines.findIndex((line) => line.trimStart().startsWith('DELETED_FILE='))
  assert.ok(start >= 0, 'compute no longer reads the deleted-package list')
  const indent = lines[start].search(/\S/)
  const end = lines.findIndex((line, i) => i > start && line === `${' '.repeat(indent)}fi`)
  assert.ok(end > start, 'subtraction block has no closing fi')
  return lines.slice(start, end + 1).map((line) => line.slice(indent)).join('\n')
}

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'qvac-deleted-pkgs-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function bash(script, env) {
  const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  assert.equal(result.status, 0, result.stderr)
  return result
}

function subtract(affected, deleted) {
  return withTemp((dir) => {
    writeFileSync(join(dir, 'nx-deleted-packages.txt'), deleted.map((pkg) => `${pkg}\n`).join(''))
    const script = `AFFECTED='${JSON.stringify(affected)}'\n${subtractionBlock()}\nprintf '%s' "$AFFECTED"`
    return JSON.parse(bash(script, { RUNNER_TEMP: dir }).stdout.split('\n').at(-1))
  })
}

// Runs Merge Guard's pkglist step with a `gh` stub that applies the step's own
// --jq filter to a fixture PR file list, as `gh api --paginate --jq` would.
function pkglist(changes, files) {
  return withTemp((dir) => {
    const fixture = join(dir, 'files.json')
    writeFileSync(fixture, JSON.stringify(files))
    const gh = join(dir, 'gh')
    writeFileSync(gh, [
      '#!/usr/bin/env bash',
      'while [ $# -gt 0 ]; do if [ "$1" = --jq ]; then q="$2"; shift; fi; shift; done',
      'jq -r "$q" "$FIXTURE"',
      '',
    ].join('\n'))
    chmodSync(gh, 0o755)
    const output = join(dir, 'output')
    writeFileSync(output, '')
    const { stdout } = bash(runBlock(guard, 'id: pkglist'), {
      PATH: `${dir}:${process.env.PATH}`,
      FIXTURE: fixture,
      GITHUB_OUTPUT: output,
      CHANGES: JSON.stringify(changes),
      ALL_PACKAGES: allPackages,
      GH_TOKEN: 'unused',
      PR_NUMBER: '1',
      REPO: 'tetherto/qvac',
    })
    const outputs = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n')
      .map((line) => [line.slice(0, line.indexOf('=')), JSON.parse(line.slice(line.indexOf('=') + 1))]))
    return { ...outputs, stdout }
  })
}

const removed = (filename) => ({ filename, status: 'removed', previous_filename: null })
const modified = (filename) => ({ filename, status: 'modified', previous_filename: null })

const FILES = [
  removed('packages/gone/package.json'),
  removed('packages/gone/src/index.ts'),
  { filename: 'packages/elsewhere/package.json', status: 'renamed', previous_filename: 'packages/vla-ggml/package.json' },
  removed('packages/kept/test/old.test.js'),
  modified('packages/edited/package.json'),
  removed('packages/gone/nested/package.json'),
]

test('both selections share one deleted-package selector', () => {
  assert.ok(matrixSelector, 'nx-project-matrix no longer derives deleted packages from the PR file statuses')
  assert.ok(guardSelector, 'Merge Guard no longer derives deleted packages from the PR file statuses')
  assert.equal(matrixSelector, guardSelector)
})

test('a removed or renamed-away package.json marks its package deleted, nothing else does', () => {
  const paths = execFileSync('jq', ['-r', matrixSelector], {
    input: FILES.map((file) => JSON.stringify(file)).join('\n'),
    encoding: 'utf8',
  })
  const dirs = paths.split('\n').filter((path) => /^packages\/[^/]+\/package\.json$/.test(path))
  assert.deepEqual([...new Set(dirs.map((path) => path.split('/')[1]))].sort(), ['gone', 'vla-ggml'])
})

test('nx-project-matrix drops deleted packages and keeps their surviving dependents', () => {
  assert.deepEqual(subtract(['dependent', 'gone', 'other'], ['gone']), ['dependent', 'other'])
  assert.deepEqual(subtract(['dependent', 'gone'], []), ['dependent', 'gone'])
})

test('nx-project-matrix subtracts after the lockfile dependents are added', () => {
  const added = action.indexOf("'. + $extra | unique'")
  const subtracted = action.indexOf("'. - $deleted'")
  const reported = action.indexOf('echo "Affected ($TARGET, transitive): $AFFECTED"')
  assert.ok(added > 0 && subtracted > added && reported > subtracted,
    'deleted packages must be dropped after DEPENDENTS, or the lockfile selection re-adds them')
})

test('Merge Guard leaves a PR with no deleted package unchanged', () => {
  const out = pkglist(['pkg-any', 'llm-llamacpp'], [modified('packages/llm-llamacpp/index.js')])
  assert.deepEqual(out.packages, ['llm-llamacpp'])
  assert.deepEqual(out['sanity-packages'], ['llm-llamacpp'])
})

test('Merge Guard drops a deleted package from both lists, including the shared-CI sweep', () => {
  const out = pkglist(['pkg-any', 'shared-ci', 'model-fit'], [
    removed('packages/model-fit/package.json'),
    removed('packages/model-fit/src/index.ts'),
    modified('.github/workflows/on-pr-nx.yml'),
  ])
  assert.deepEqual(out.packages, [], 'verify-prebuilds would wait for a status nothing posts')
  assert.deepEqual(out['sanity-packages'], JSON.parse(allPackages).filter((pkg) => pkg !== 'model-fit'))
  assert.ok(!out['packages-with-path'].some(({ package: pkg }) => pkg === 'model-fit'))
  assert.match(out.stdout, /no remaining package path did/)
})

test('Merge Guard maps the vla key to packages/vla-ggml', () => {
  const out = pkglist(['pkg-any', 'vla', 'fabric'], [
    removed('packages/vla-ggml/package.json'),
    modified('packages/fabric/index.js'),
  ])
  assert.deepEqual(out.packages, ['fabric'])
})
