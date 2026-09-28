// nx.json ignores pnpm-lock.yaml for affected selection, and the matrix action
// falls back to today's behaviour only when no workspace manifest explains a
// lockfile change.
// Both halves are needed: the first alone lets a transitive bump merge untested,
// the second alone changes nothing. These tests pin both.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const script = join(root, '.github/actions/nx-project-matrix/lockfile-mode.sh')
const action = join(root, '.github/actions/nx-project-matrix/action.yml')

const mode = (...paths) =>
  execFileSync('bash', [script], { input: paths.map((p) => `${p}\n`).join('') })
    .toString()
    .trim()

test('a lockfile change with no workspace manifest keeps today\'s behaviour', () => {
  assert.equal(mode('pnpm-lock.yaml'), 'all')
})

test('a lockfile change riding along other files, with no manifest, keeps today\'s behaviour', () => {
  assert.equal(mode('pnpm-lock.yaml', 'packages/llm-llamacpp/src/index.js'), 'all')
})

test('a dependency bump selects through its package.json, not the lockfile', () => {
  assert.equal(mode('pnpm-lock.yaml', 'packages/llm-llamacpp/package.json'), '')
})

test('the root package.json owns a lockfile change too', () => {
  assert.equal(mode('pnpm-lock.yaml', 'package.json'), '')
})

test('no lockfile change leaves the empty list in charge', () => {
  assert.equal(mode('packages/llm-llamacpp/src/index.js'), '')
  assert.equal(mode(''), '')
})

test('only the root lockfile counts, not one nested in a package', () => {
  assert.equal(mode('packages/x/pnpm-lock.yaml'), '')
})

test('only workspace manifests own a lockfile change', () => {
  // pnpm-workspace.yaml: packages/*, registry-server client+shared, plugins/*
  assert.equal(mode('pnpm-lock.yaml', 'plugins/opencode-plugin/package.json'), '')
  assert.equal(mode('pnpm-lock.yaml', 'packages/registry-server/client/package.json'), '')
  // Not workspace members, so they explain nothing in this lockfile.
  assert.equal(mode('pnpm-lock.yaml', 'docs/website/package.json'), 'all')
  assert.equal(mode('pnpm-lock.yaml', 'packages/llm-llamacpp/benchmarks/server/package.json'), 'all')
  assert.equal(
    mode('pnpm-lock.yaml', 'packages/inference-addon-cpp/tests/integration_js/x/package.json'),
    'all'
  )
})

test('a path list larger than the pipe buffer is still read correctly', () => {
  // grep -q exits on the first match; with `printf | grep -q` under pipefail the
  // writer's SIGPIPE turned a match into a failure once the list grew past ~64KB.
  const filler = Array.from({ length: 6000 }, (_, i) => `packages/llm-llamacpp/src/f${i}.js`)
  assert.equal(mode('pnpm-lock.yaml', ...filler), 'all')
  assert.equal(mode('packages/llm-llamacpp/package.json', ...filler, 'pnpm-lock.yaml'), '')
})

test('nx.json ignores the lockfile for affected selection', () => {
  const nx = JSON.parse(readFileSync(join(root, 'nx.json'), 'utf8'))
  assert.deepEqual(
    nx.pluginsConfig?.['@nx/js']?.projectsAffectedByDependencyUpdates,
    [],
    'nx.json must set projectsAffectedByDependencyUpdates to [] — "all" (the ' +
      'default) and "auto" both select most of the workspace on a one-line ' +
      'dependency change, because pnpm rewrites shared lockfile entries'
  )
})

test('the matrix action still applies the lockfile-only fallback', () => {
  const source = readFileSync(action, 'utf8')
  assert.match(
    source,
    /lockfile-mode\.sh/,
    'nx-project-matrix no longer calls lockfile-mode.sh, so a lockfile-only ' +
      'change would select no projects and merge untested'
  )
})
