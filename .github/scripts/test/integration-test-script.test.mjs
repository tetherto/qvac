import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
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
const PREBUILD_LIBRARY_PATH = '{workspace}/{workdir}/prebuilds/{platform}-{arch}'
const CUDA_LIBRARY_PATH = '/usr/local/cuda/lib64'

const workflow = readFileSync(join(root, WORKFLOW), 'utf8')
const DEFAULT_RUN_STEP = 'Run integration tests\n'
const MATRIX_SUFFIX = "${{ matrix.testCommandSuffix && format('{0}-{1}', matrix.platform, matrix.arch) || '' }}"
const NPM_FIXTURE = `#!/usr/bin/env node
console.log(JSON.stringify({backend: process.env.TTS_CPP_GPU_BACKEND, literal: process.env.TEST_LITERAL, args: process.argv.slice(2)}))
process.exit(Number(process.env.FIXTURE_EXIT || 0))
`

function runDefaultIntegrationStep(testEnv, exitCode = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'qvac-integration-env-'))
  try {
    writeFileSync(join(directory, 'npm'), NPM_FIXTURE, { mode: 0o755 })
    const step = workflow.split(STEP_SEPARATOR).find((part) => part.startsWith(DEFAULT_RUN_STEP))
    assert.ok(step, 'missing non-tee integration step')
    assert.ok(step.includes('QVAC_TEST_ENV: ${{ toJSON(matrix.testEnv) }}'))
    const script = step.split('        run: |\n')[1].split('\n')
      .map((line) => line.slice(10)).join('\n').replace(MATRIX_SUFFIX, '')
    return spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, QVAC_ENV_NAME: '',
        QVAC_TEST_ENV: JSON.stringify(testEnv), TTS_CPP_GPU_BACKEND: 'inherited',
        TEST_SCRIPT: DEFAULT_TEST_SCRIPT, FIXTURE_EXIT: String(exitCode) },
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

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
  const row = rowsOf(pkg).find(
    (candidate) => candidate.platform === 'darwin' && candidate.arch === 'x64'
  )
  assert.ok(row, `${pkg} has no darwin-x64 integration row`)
  return row.testScript ?? DEFAULT_TEST_SCRIPT
}

function packagesRunningFullSuiteOnDarwinX64() {
  return DARWIN_X64_SMOKE_PACKAGES.filter(
    (pkg) => darwinX64TestScriptOf(pkg) === DEFAULT_TEST_SCRIPT
  )
}

test('the workflow has integration run steps to check', () => {
  assert.ok(findRunSteps().length > 0)
})

test('every integration run step runs the row test script', () => {
  const steps = findRunSteps()
  assert.deepEqual(
    namesOfStepsMatching(steps, (step) => !step.includes(TEST_SCRIPT_ENV)),
    []
  )
})

test('no integration run step hardcodes the default test script', () => {
  const steps = findRunSteps()
  assert.deepEqual(
    namesOfStepsMatching(steps, (step) => HARDCODED_DEFAULT_RUN.test(step)),
    []
  )
})

test('every declared integration script exists in its package manifest', () => {
  assert.deepEqual(listPackagesWithIntegrationCi().flatMap(missingScriptsOf), [])
})

test('bci-whispercpp and tts-ggml run a smoke script on darwin-x64, not the full suite', () => {
  assert.deepEqual(packagesRunningFullSuiteOnDarwinX64(), [])
})

test('TTS Linux GPU integration rows pin both CUDA and Vulkan', () => {
  const gpuRows = rowsOf('tts-ggml').filter(
    (row) => row.platform === 'linux' && row.arch === 'x64' && !row.noGpu
  )
  assert.ok(gpuRows.length > 0, 'TTS has no Linux GPU integration coverage')
  const backends = gpuRows.map((row) => row.testEnv?.TTS_CPP_GPU_BACKEND)
  assert.ok(
    backends.every((backend) => ['cuda', 'vulkan'].includes(backend)),
    'each GPU row must pin its backend'
  )
  assert.deepEqual([...new Set(backends)].sort(), ['cuda', 'vulkan'])
  const cudaRow = gpuRows.find((row) => row.testEnv.TTS_CPP_GPU_BACKEND === 'cuda')
  assert.equal(cudaRow.modelEnv.LD_LIBRARY_PATH, `${PREBUILD_LIBRARY_PATH}:${CUDA_LIBRARY_PATH}`)
  assert.equal(cudaRow.modelEnv.DYLD_LIBRARY_PATH, PREBUILD_LIBRARY_PATH)
  assert.equal(
    cudaRow.modelEnv.INTEGRATION_TEST_TIMEOUT,
    integrationCiOf('tts-ggml').modelEnv.INTEGRATION_TEST_TIMEOUT
  )
  assert.equal(cudaRow.testEnv.LD_LIBRARY_PATH, undefined)
})

test('manual integration dispatch forwards the trusted config override', () => {
  const orchestrator = readFileSync(join(root, '.github/workflows/on-pr-nx.yml'), 'utf8')
  const integrationJob = orchestrator
    .split('\n  run-integration-tests:\n')[1]
    ?.split('\n  # Mobile integration tests')[0]
  assert.ok(integrationJob, 'missing integration caller')
  assert.ok(
    integrationJob.includes(
      "base-ref: ${{ github.event_name == 'workflow_dispatch' && inputs.config_ref_override || github.event.repository.default_branch }}"
    ),
    'only a trusted manual dispatch may override the integration config source'
  )
})

for (const backend of ['cuda', 'vulkan']) {
  test(`the non-tee integration step exports the ${backend} row backend to npm`, () => {
    const result = runDefaultIntegrationStep({ TTS_CPP_GPU_BACKEND: backend })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { backend, args: ['run', DEFAULT_TEST_SCRIPT] })
  })
}

test('the non-tee integration step preserves quoted values without shell evaluation', () => {
  const literal = "a b 'quoted' $(exit 73)"
  const result = runDefaultIntegrationStep({ TEST_LITERAL: literal })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).literal, literal)
})

test('the non-tee integration step accepts absent row environment and propagates test failures', () => {
  const result = runDefaultIntegrationStep(null, 42)
  assert.equal(result.status, 42, result.stderr)
  assert.equal(JSON.parse(result.stdout).backend, 'inherited')
})
