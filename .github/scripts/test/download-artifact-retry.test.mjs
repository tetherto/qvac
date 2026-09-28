import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const RETRY_ACTION = '.github/actions/download-artifact-retry/action.yml'
const MATERIALIZE_ACTION = '.github/actions/prebuild-artifact-materialize/action.yml'
const RAW_DOWNLOAD = 'uses: actions/download-artifact@'
const RETRY_USES = 'uses: ./.github/actions/download-artifact-retry'
const STEP_SEPARATOR = '\n    - name: '

const FIRST = 'Download artifact'
const FIRST_WAIT = 'Wait before the first retry'
const SECOND = 'Download artifact (first retry)'
const FINAL_WAIT = 'Wait before the final retry'
const FINAL = 'Download artifact (final retry)'

function readRepoFile(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8')
}

function splitSteps(src) {
  return src.split(STEP_SEPARATOR).slice(1)
}

function stepName(step) {
  return step.slice(0, step.indexOf('\n')).trim()
}

function findStep(src, name) {
  const step = splitSteps(src).find((candidate) => stepName(candidate) === name)
  assert.ok(step, `step not found: ${name}`)
  return step
}

function withBlock(step) {
  return step.slice(step.indexOf('with:')).trimEnd()
}

function downloadStepNames(src) {
  return splitSteps(src)
    .filter((step) => step.includes(RAW_DOWNLOAD))
    .map(stepName)
}

const retrySrc = readRepoFile(RETRY_ACTION)

test('the retry action attempts the download three times, in order', () => {
  assert.deepEqual(downloadStepNames(retrySrc), [FIRST, SECOND, FINAL])
})

test('only the final attempt may fail the action', () => {
  assert.match(findStep(retrySrc, FIRST), /continue-on-error: true/)
  assert.match(findStep(retrySrc, SECOND), /continue-on-error: true/)
  assert.doesNotMatch(findStep(retrySrc, FINAL), /continue-on-error/)
})

test('each retry and its wait run only after the previous attempt failed', () => {
  assert.match(findStep(retrySrc, FIRST_WAIT), /if: steps\.first\.outcome == 'failure'/)
  assert.match(findStep(retrySrc, SECOND), /if: steps\.first\.outcome == 'failure'/)
  assert.match(findStep(retrySrc, FINAL_WAIT), /if: steps\.second\.outcome == 'failure'/)
  assert.match(findStep(retrySrc, FINAL), /if: steps\.second\.outcome == 'failure'/)
})

test('the step ids the retry conditions read are declared', () => {
  assert.match(findStep(retrySrc, FIRST), /id: first/)
  assert.match(findStep(retrySrc, SECOND), /id: second/)
})

test('every attempt forwards the same inputs', () => {
  const expected = withBlock(findStep(retrySrc, FIRST))
  assert.equal(withBlock(findStep(retrySrc, SECOND)), expected)
  assert.equal(withBlock(findStep(retrySrc, FINAL)), expected)
})

test('prebuild materialization downloads through the retry action', () => {
  const materializeSrc = readRepoFile(MATERIALIZE_ACTION)
  assert.ok(!materializeSrc.includes(RAW_DOWNLOAD), 'materialize must not call download-artifact directly')
  assert.match(findStep(materializeSrc, 'Download prebuilds bundle'), new RegExp(RETRY_USES.replaceAll('.', '\\.')))
})
