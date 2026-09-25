import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { makeWorkspace, readRepoFile, runBashStep, workflowStepRun } from '../lib/sdk-e2e-rerun.mjs'

const WORKFLOW = 'pr-gate-merge.yml'
const STEP = 'Build package lists'
const STEP_ANCHOR = `- name: ${STEP}`
const ALL_PACKAGES_KEY = 'ALL_PACKAGES: >-'
const SHARED_CI_ONLY = '["shared-ci"]'
const ONE_PACKAGE = '["tts-ggml","shared-ci"]'
const OUTPUT_LINE = /^[a-z-]+=\S/

function indentOf(line) {
  return line.length - line.trimStart().length
}

function linesAfter(lines, index, parentIndent) {
  const body = []
  for (let i = index + 1; i < lines.length && indentOf(lines[i]) > parentIndent; i++) {
    body.push(lines[i])
  }
  return body
}

function allPackagesValue() {
  const lines = readRepoFile(`.github/workflows/${WORKFLOW}`).split('\n')
  const stepIndex = lines.findIndex((line) => line.trim() === STEP_ANCHOR)
  const keyIndex = lines.findIndex((line, i) => i > stepIndex && line.trim() === ALL_PACKAGES_KEY)
  assert.ok(stepIndex !== -1 && keyIndex !== -1, `${ALL_PACKAGES_KEY} not found under ${STEP}`)
  const body = linesAfter(lines, keyIndex, indentOf(lines[keyIndex]))
  const blockIndent = Math.min(...body.map(indentOf))
  return body.map((line) => line.slice(blockIndent)).join('\n')
}

function runPackageLists(changes) {
  const workspace = makeWorkspace()
  try {
    const result = runBashStep(workflowStepRun(WORKFLOW, STEP), {
      cwd: workspace.dir,
      env: { CHANGES: changes, ALL_PACKAGES: allPackagesValue() }
    })
    const raw = readFileSync(`${workspace.dir}/step-output.txt`, 'utf8')
    return { ...result, rawLines: raw.split('\n').filter((line) => line !== '') }
  } finally {
    workspace.cleanup()
  }
}

test('the all-packages list really spans several lines in the workflow', () => {
  assert.ok(allPackagesValue().includes('\n'), 'the fixture no longer exercises a multi-line value')
})

test('a shared-CI-only change writes one well-formed line per output', () => {
  const { status, rawLines } = runPackageLists(SHARED_CI_ONLY)
  assert.equal(status, 0)
  assert.deepEqual(rawLines.filter((line) => !OUTPUT_LINE.test(line)), [])
})

test('a shared-CI-only change runs sanity-checks on every package', () => {
  const { outputs } = runPackageLists(SHARED_CI_ONLY)
  const expected = JSON.parse(allPackagesValue())
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
