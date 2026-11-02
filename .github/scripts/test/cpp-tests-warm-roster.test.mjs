import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SHARED_CACHE_INPUTS, WARMED_ELSEWHERE, buildsInNxCppTests, readProjects, selectPushedPackages, selectRoster,
} from '../cpp-tests-warm-roster.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const WORKFLOWS = join(ROOT, '.github/workflows')
const NX_WORKFLOW = readWorkflow('cpp-tests-nx.yml')
const LEGACY_WARMER_PREFIX = 'on-merge-vcpkg-cache-'
const NX_DISPATCH = 'gh workflow run "cpp-tests-nx.yml"'
const SPEECH_PACKAGES = ['asr-ggml', 'bci-whispercpp', 'tts-ggml']
const EVERY_TWO_DAYS = /^\d{1,2} \d{1,2} \*\/2 \* \*$/
const WARM_STEP = 'Select packages to warm'
const FETCH_FAILS = 'git() { return 1; }'
const GIT_FORBIDDEN = 'git() { exit 97; }'
const PUSHED_TTS_VCPKG = "git() { case \"$1\" in fetch) return 0 ;; diff) printf 'packages/tts-ggml/vcpkg.json\\n' ;; esac; }"

function readWorkflow(name) {
  return readFileSync(join(WORKFLOWS, name), 'utf8').replaceAll('\r\n', '\n')
}

function project(onPrCi, cppCi) {
  const targets = {}
  if (onPrCi !== undefined) targets['on-pr'] = { options: { ci: onPrCi } }
  if (cppCi !== undefined) targets['test:cpp'] = { options: { ci: cppCi } }
  return { targets }
}

function legacyWarmers() {
  return readdirSync(WORKFLOWS).filter((name) => name.startsWith(LEGACY_WARMER_PREFIX))
}

function carveOutWorkflows() {
  return [...NX_WORKFLOW.matchAll(/uses: \.\/\.github\/workflows\/([\w.-]+\.yml)/g)].map((match) => match[1])
}

function dispatchesWorkflow(warmer, workflow) {
  return readWorkflow(warmer).includes(`gh workflow run "${workflow}"`)
}

function dispatchedNxPackages(source) {
  if (!source.includes(NX_DISPATCH)) return []
  return [...source.matchAll(/packages=\[([^\]]*)\]/g)]
    .flatMap((match) => JSON.parse(`[${match[1].replaceAll('\\"', '"')}]`))
}

function crons(source) {
  return [...source.matchAll(/- cron: "([^"]+)"/g)].map((match) => match[1])
}

function pushPaths(source) {
  const block = source.split('\n  push:\n')[1].split('\n  schedule:\n')[0]
  return [...block.matchAll(/^ {6}- '([^']+)'$/gm)].map((match) => match[1])
}

function toPathFilter(input) {
  if (input.endsWith('/')) return `${input}**`
  if (input.endsWith('-')) return `${input}*/**`
  return input
}

function stepBody(source, name) {
  const block = source.split('\n      - ').find((text) => text.startsWith(`name: ${name}\n`))
  assert.ok(block, `Missing step: ${name}`)
  return block.split('        run: |\n')[1].split('\n')
    .filter((line) => line.startsWith('          ')).map((line) => line.slice(10)).join('\n')
}

function runWarmStep(eventName, gitStub) {
  const directory = mkdtempSync(join(tmpdir(), 'cpp-warm-'))
  const output = join(directory, 'output')
  try {
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', `${gitStub}\n${stepBody(NX_WORKFLOW, WARM_STEP)}`], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, EVENT_NAME: eventName, BEFORE_SHA: 'before', HEAD_SHA: 'head', RUNNER_TEMP: directory, GITHUB_OUTPUT: output },
    })
    assert.equal(result.status, 0, result.stderr + result.stdout)
    return JSON.parse(readFileSync(output, 'utf8').match(/^packages=(.+)$/m)[1])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('roster keeps only packages whose PR legs build in the cpp-tests-nx matrix', () => {
  const projects = new Map([
    ['matrix', project({}, { mode: 'coverage' })],
    ['legacy-pr-lane', project({ carveOut: true }, { mode: 'standard' })],
    ['carved-out-cpp', project({}, { carveOut: true })],
    ['no-cpp-ci', { targets: { 'on-pr': { options: { ci: {} } }, 'test:cpp': { options: {} } } }],
    ['no-pr-target', project(undefined, { mode: 'standard' })],
    ['embed-llamacpp', project({}, { mode: 'standard' })],
  ])
  assert.deepEqual(selectRoster(projects), ['matrix'])
})

test('a push warms what it touched, and everything after a shared cache input change', () => {
  const roster = ['asr-ggml', 'tts-ggml']
  assert.deepEqual(selectPushedPackages(roster, null), roster)
  assert.deepEqual(selectPushedPackages(roster, ['packages/tts-ggml/addon/src/x.cpp', 'docs/x.md']), ['tts-ggml'])
  assert.deepEqual(selectPushedPackages(roster, ['packages/tts-ggml-extra/x.cpp', 'packages/sdk/x.ts']), [])
  assert.deepEqual(selectPushedPackages(roster, ['.github/actions/setup-vcpkg/action.yml']), [])
  const sharedChanges = [
    '.github/workflows/cpp-tests-nx.yml',
    '.github/actions/vcpkg-toolchain-fingerprint/action.yml',
    '.github/actions/vcpkg-binary-cache-dir/action.yml',
    '.github/scripts/configure-cpp-build.mjs',
    'vcpkg-overlays/triplets/x64-linux.cmake',
  ]
  sharedChanges.forEach((path) => assert.deepEqual(selectPushedPackages(roster, [path]), roster, path))
})

test('repository roster covers the speech packages and skips packages warmed elsewhere', () => {
  const projects = readProjects(ROOT)
  const roster = selectRoster(projects)
  SPEECH_PACKAGES.forEach((name) => assert.ok(roster.includes(name), name))
  roster.forEach((name) => assert.ok((projects.get(name).targets['test:cpp'].options.ci.platforms ?? []).length > 0, `${name} declares no test:cpp platforms`))
  WARMED_ELSEWHERE.forEach((_, name) => {
    assert.ok(!roster.includes(name), name)
    assert.ok(buildsInNxCppTests(projects.get(name)), `${name} no longer builds in cpp-tests-nx; drop it from WARMED_ELSEWHERE`)
  })
})

test('every legacy warmer that dispatches cpp-tests-nx is registered in WARMED_ELSEWHERE', () => {
  const dispatched = legacyWarmers().flatMap((file) => dispatchedNxPackages(readWorkflow(file)).map((name) => [name, file]))
  assert.deepEqual(new Map(dispatched), WARMED_ELSEWHERE)
})

test('push paths mirror the shared cache inputs', () => {
  assert.deepEqual(pushPaths(NX_WORKFLOW).sort(), ['packages/**', ...SHARED_CACHE_INPUTS.map(toPathFilter)].sort())
})

test('warm schedules run every 2 days, staggered from every other warmer', () => {
  assert.equal(crons(NX_WORKFLOW).length, 1)
  const all = [NX_WORKFLOW, ...[...carveOutWorkflows(), ...legacyWarmers()].map(readWorkflow)].flatMap(crons)
  all.forEach((cron) => assert.match(cron, EVERY_TWO_DAYS))
  assert.equal(new Set(all).size, all.length)
})

test('every carve-out cpp-tests-nx calls is warmed on a schedule, by itself or by a legacy warmer', () => {
  const carveOuts = carveOutWorkflows()
  assert.ok(carveOuts.length > 0)
  carveOuts.forEach((workflow) => assert.ok(
    crons(readWorkflow(workflow)).length > 0 || legacyWarmers().some((warmer) => dispatchesWorkflow(warmer, workflow)),
    `${workflow} has no warm path, so its PR legs go cold once the cache server prunes its entry`,
  ))
})

test('the matrix job hands the warm selection to nx-project-matrix and skips an empty one', () => {
  assert.ok(NX_WORKFLOW.includes("if: github.event_name == 'push' || github.event_name == 'schedule'\n"))
  assert.ok(NX_WORKFLOW.includes("if: steps.warm.outputs.packages != '[]'\n"))
  assert.ok(NX_WORKFLOW.includes('packages: ${{ steps.warm.outputs.packages || inputs.packages }}\n'))
})

test('the warm step selects pushed packages and falls back to the whole roster', () => {
  const roster = selectRoster(readProjects(ROOT))
  assert.deepEqual(runWarmStep('schedule', GIT_FORBIDDEN), roster)
  assert.deepEqual(runWarmStep('push', FETCH_FAILS), roster)
  assert.deepEqual(runWarmStep('push', PUSHED_TTS_VCPKG), ['tts-ggml'])
})
