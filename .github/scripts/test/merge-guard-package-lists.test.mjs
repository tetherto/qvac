import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { makeWorkspace, readRepoFile, runBashStep, workflowStepRun } from '../lib/sdk-e2e-rerun.mjs'

const WORKFLOW = 'pr-gate-merge.yml'
const STEP = 'Build package lists'
const STEP_ANCHOR = `- name: ${STEP}`
const ALL_PACKAGES_LINE = /^\s*ALL_PACKAGES: '(.+)'$/
const SHARED_CI_ONLY = '["shared-ci"]'
const ONE_PACKAGE = '["tts-ggml","shared-ci"]'
const OUTPUT_LINE = /^[a-z-]+=\S/
const ONE_PACKAGE_PER_LINE = 1

function allPackagesValue() {
  const lines = readRepoFile(`.github/workflows/${WORKFLOW}`).split('\n')
  const stepIndex = lines.findIndex((line) => line.trim() === STEP_ANCHOR)
  const match = lines
    .slice(stepIndex + 1)
    .map((line) => line.match(ALL_PACKAGES_LINE))
    .find(Boolean)
  assert.ok(stepIndex !== -1 && match, `ALL_PACKAGES not found under ${STEP}`)
  return match[1]
}

function workflowPackages() {
  return JSON.parse(allPackagesValue())
}

function multiLinePackages() {
  return JSON.stringify(workflowPackages(), null, ONE_PACKAGE_PER_LINE)
}

function runPackageLists(changes) {
  const workspace = makeWorkspace()
  try {
    const result = runBashStep(workflowStepRun(WORKFLOW, STEP), {
      cwd: workspace.dir,
      env: { CHANGES: changes, ALL_PACKAGES: multiLinePackages() }
    })
    const raw = readFileSync(`${workspace.dir}/step-output.txt`, 'utf8')
    return { ...result, rawLines: raw.split('\n').filter((line) => line !== '') }
  } finally {
    workspace.cleanup()
  }
}

test('the fixture feeds the step a multi-line all-packages list', () => {
  assert.ok(multiLinePackages().includes('\n'))
})

test('a shared-CI-only change writes one well-formed line per output', () => {
  const { status, rawLines } = runPackageLists(SHARED_CI_ONLY)
  assert.equal(status, 0)
  assert.deepEqual(rawLines.filter((line) => !OUTPUT_LINE.test(line)), [])
})

test('a shared-CI-only change runs sanity-checks on every package', () => {
  const { outputs } = runPackageLists(SHARED_CI_ONLY)
  const expected = workflowPackages()
  assert.deepEqual(JSON.parse(outputs['sanity-packages']), expected)
  assert.deepEqual(JSON.parse(outputs['packages-with-path']).map((entry) => entry.package), expected)
  assert.deepEqual(JSON.parse(outputs.packages), [])
})

test('a package change still scopes every list to that package', () => {
  const { status, outputs } = runPackageLists(ONE_PACKAGE)
  assert.equal(status, 0)
  assert.deepEqual(JSON.parse(outputs.packages), ['tts-ggml'])
  assert.deepEqual(JSON.parse(outputs['sanity-packages']), ['tts-ggml'])
})
