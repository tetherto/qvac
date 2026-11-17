import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const PACKAGES_DIR = 'packages'
const TARGET = 'test:integration'
const DEFAULT_TEST_SCRIPT = 'test:integration'
const SCRIPT_FIELDS = ['testScript', 'modelDownloadScript']
const DARWIN_X64_SMOKE_PACKAGES = ['bci-whispercpp', 'tts-ggml']
const CUDA_LIBRARY_PATH = '/usr/local/cuda/lib64'

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8'))
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

// On the CI contract a configuration picks its suite with `--script <name>` in its args.
function darwinX64TestScriptOf(pkg) {
  const config = readJson(join(PACKAGES_DIR, pkg, 'project.json')).targets[TARGET].configurations?.[
    'darwin-x64'
  ]
  assert.ok(config, `${pkg} has no darwin-x64 integration configuration`)
  return config.args?.match(/--script (\S+)/)?.[1] ?? DEFAULT_TEST_SCRIPT
}

function packagesRunningFullSuiteOnDarwinX64() {
  return DARWIN_X64_SMOKE_PACKAGES.filter(
    (pkg) => darwinX64TestScriptOf(pkg) === DEFAULT_TEST_SCRIPT
  )
}

test('every declared integration script exists in its package manifest', () => {
  assert.deepEqual(listPackagesWithIntegrationCi().flatMap(missingScriptsOf), [])
})

test('bci-whispercpp and tts-ggml run a smoke script on darwin-x64, not the full suite', () => {
  assert.deepEqual(packagesRunningFullSuiteOnDarwinX64(), [])
})

test('TTS Linux GPU integration rows pin both CUDA and Vulkan', async () => {
  const configs = readJson(join(PACKAGES_DIR, 'tts-ggml', 'project.json')).targets[TARGET].configurations
  const gpuRows = Object.entries(configs)
    .filter(([name, config]) => name.startsWith('linux-x64') && !/NO_GPU=true/.test(config.args ?? ''))
    .map(([, config]) => config.args ?? '')
  assert.ok(gpuRows.length > 0, 'TTS has no Linux GPU integration coverage')
  const backends = gpuRows.map((args) => args.match(/--set TTS_CPP_GPU_BACKEND=(\S+)/)?.[1])
  assert.ok(
    backends.every((backend) => ['cuda', 'vulkan'].includes(backend)),
    'each GPU row must pin its backend'
  )
  assert.deepEqual([...new Set(backends)].sort(), ['cuda', 'vulkan'])
  const cudaArgs = gpuRows.find((args) => args.includes('TTS_CPP_GPU_BACKEND=cuda')).split(/\s+/)
  const { options } = await import(join(root, PACKAGES_DIR, 'tts-ggml', 'ci', 'integration.mjs'))
  const prebuilds = join(root, PACKAGES_DIR, 'tts-ggml', 'prebuilds', `${process.platform}-${process.arch}`)
  const cuda = options(cudaArgs, {}).env
  assert.equal(cuda.LD_LIBRARY_PATH, `${prebuilds}:${CUDA_LIBRARY_PATH}`)
  assert.equal(cuda.DYLD_LIBRARY_PATH, prebuilds)
  assert.equal(cuda.INTEGRATION_TEST_TIMEOUT, options([], {}).env.INTEGRATION_TEST_TIMEOUT)
  assert.ok(!cudaArgs.some((arg) => arg.startsWith('LD_LIBRARY_PATH=')))
})

