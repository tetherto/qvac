import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const WORKFLOW = '.github/workflows/integration-test-nx.yml'
const PACKAGES_DIR = 'packages'
const TARGET = 'test:integration'
const DEFAULT_TEST_SCRIPT = 'test:integration'
const STEP_SEPARATOR = '\n      - name: '
const RUN_STEP_PREFIX = 'Run integration tests'
const TEST_SCRIPT_ENV = `TEST_SCRIPT: \${{ matrix.testScript || '${DEFAULT_TEST_SCRIPT}' }}`
const HARDCODED_DEFAULT_RUN = /npm run test:integration(?!:)/
const SCRIPT_FIELDS = ['testScript', 'modelDownloadScript']
const DARWIN_X64_SMOKE_PACKAGES = ['bci-whispercpp', 'tts-ggml']

const workflow = readFileSync(join(root, WORKFLOW), 'utf8')

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8'))
}

function stepName(step) {
  return step.slice(0, step.indexOf('\n'))
}

function findRunSteps() {
  return workflow.split(STEP_SEPARATOR).filter((step) => step.startsWith(RUN_STEP_PREFIX))
}

function namesOfStepsMatching(steps, predicate) {
  return steps.filter(predicate).map(stepName)
}

function integrationCiOf(pkg) {
  const projectPath = join(PACKAGES_DIR, pkg, 'project.json')
  if (!existsSync(join(root, projectPath))) return undefined
  return readJson(projectPath).targets?.[TARGET]?.options?.ci
}

function listPackagesWithIntegrationCi() {
  return readdirSync(join(root, PACKAGES_DIR)).filter((pkg) => integrationCiOf(pkg))
}

function rowsOf(pkg) {
  const { platforms, ...shared } = integrationCiOf(pkg)
  return (platforms ?? [{}]).map((row) => ({ ...shared, ...row }))
}

function declaredScriptsOf(pkg) {
  return rowsOf(pkg).flatMap((row) => SCRIPT_FIELDS.map((field) => row[field]).filter(Boolean))
}

function missingScriptsOf(pkg) {
  const { scripts = {} } = readJson(join(PACKAGES_DIR, pkg, 'package.json'))
  return declaredScriptsOf(pkg)
    .filter((name) => !(name in scripts))
    .map((name) => `${pkg}: ${name}`)
}

function darwinX64TestScriptOf(pkg) {
  const row = rowsOf(pkg).find((candidate) => candidate.platform === 'darwin' && candidate.arch === 'x64')
  assert.ok(row, `${pkg} has no darwin-x64 integration row`)
  return row.testScript ?? DEFAULT_TEST_SCRIPT
}

function packagesRunningFullSuiteOnDarwinX64() {
  return DARWIN_X64_SMOKE_PACKAGES.filter((pkg) => darwinX64TestScriptOf(pkg) === DEFAULT_TEST_SCRIPT)
}

test('the workflow has integration run steps to check', () => {
  assert.ok(findRunSteps().length > 0)
})

test('every integration run step runs the row test script', () => {
  const steps = findRunSteps()
  assert.deepEqual(namesOfStepsMatching(steps, (step) => !step.includes(TEST_SCRIPT_ENV)), [])
})

test('no integration run step hardcodes the default test script', () => {
  const steps = findRunSteps()
  assert.deepEqual(namesOfStepsMatching(steps, (step) => HARDCODED_DEFAULT_RUN.test(step)), [])
})

test('every declared integration script exists in its package manifest', () => {
  assert.deepEqual(listPackagesWithIntegrationCi().flatMap(missingScriptsOf), [])
})

test('bci-whispercpp and tts-ggml run a smoke script on darwin-x64, not the full suite', () => {
  assert.deepEqual(packagesRunningFullSuiteOnDarwinX64(), [])
})
