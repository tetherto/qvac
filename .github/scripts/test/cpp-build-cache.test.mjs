import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configureCppBuild, writeBuildSettings } from '../configure-cpp-build.mjs'
import { CPP_TEST_KEYS } from '../prebuild-status/lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SPEECH_PACKAGES = ['asr-ggml', 'tts-ggml', 'bci-whispercpp']
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/cpp-tests-nx.yml'), 'utf8')

function step(name) {
  const block = WORKFLOW.split('\n      - ').find((text) => text.startsWith(`name: ${name}\n`))
  assert.ok(block, `Missing step: ${name}`)
  return block
}

function environment(overrides = {}) {
  return { CPP_PACKAGE: 'asr-ggml', CPP_HAS_CCACHE: 'true', RUNNER_TEMP: tmpdir(), GITHUB_WORKSPACE: ROOT, ...overrides }
}

test('coverage builds cap CMake and vcpkg concurrency together', () => {
  const defaults = configureCppBuild(environment())
  assert.equal(defaults.CMAKE_BUILD_PARALLEL_LEVEL, '2')
  assert.equal(defaults.VCPKG_MAX_CONCURRENCY, '2')
  const overrides = configureCppBuild(environment({ CPP_BUILD_JOBS: '4' }))
  assert.equal(overrides.CMAKE_BUILD_PARALLEL_LEVEL, '4')
  assert.equal(overrides.VCPKG_MAX_CONCURRENCY, '4')
  for (const value of ['0', '-1', '1.5', '2\nINJECTED=true']) {
    assert.throws(() => configureCppBuild(environment({ CPP_BUILD_JOBS: value })), /positive integer/)
  }
})

test('compiler caches are isolated per package and use compiler contents', () => {
  const settings = configureCppBuild(environment())
  assert.equal(settings.CCACHE_DIR, join(tmpdir(), 'cpp-ccache', 'asr-ggml'))
  assert.equal(settings.CCACHE_BASEDIR, ROOT)
  assert.equal(settings.CCACHE_COMPILERCHECK, 'content')
  assert.equal(settings.CMAKE_CXX_COMPILER_LAUNCHER, 'ccache')
  assert.notEqual(settings.CCACHE_DIR, configureCppBuild(environment({ CPP_PACKAGE: 'tts-ggml' })).CCACHE_DIR)
  assert.equal(configureCppBuild(environment({ CPP_HAS_CCACHE: 'false' })).CCACHE_DIR, undefined)
  assert.throws(() => configureCppBuild(environment({ CPP_PACKAGE: '../other' })), /short-name/)
})

test('build settings export valid GitHub environment lines and reject injection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cpp-build-settings-'))
  const output = join(directory, 'env')
  try {
    writeBuildSettings(environment({ GITHUB_ENV: output }))
    assert.match(readFileSync(output, 'utf8'), /^VCPKG_MAX_CONCURRENCY=2$/m)
    writeFileSync(output, '')
    assert.throws(() => writeBuildSettings(environment({ GITHUB_ENV: output, RUNNER_TEMP: 'temp\nINJECTED=true' })), /single line/)
    assert.equal(readFileSync(output, 'utf8'), '')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('coverage jobs use persistent, toolchain-keyed dependency caches', () => {
  assert.match(step('Manual Workspace Cleanup'), /if: runner\.environment != 'github-hosted'/)
  for (const name of ['Point vcpkg at its binary cache', 'Fingerprint the toolchain', 'Get vcpkg cache (restore)', 'Sync the host and workspace vcpkg caches', 'Save vcpkg cache (trusted contexts)']) {
    assert.doesNotMatch(step(name), /matrix\.mode == 'standard'/, `${name} must include coverage`)
  }
  const restore = step('Get vcpkg cache (restore)')
  assert.match(restore, /matrix\.mode/)
  assert.match(restore, /vcpkg\/triplets\/\*\*/)
  assert.match(restore, /env\.TOOLCHAIN_FINGERPRINT/)
  for (const name of ['Save vcpkg cache (trusted contexts)', 'Save ccache (trusted contexts)']) {
    const save = step(name)
    assert.match(save, /github\.event_name == 'push'/)
    assert.match(save, /github\.event\.repository\.default_branch/)
    assert.match(save, /inputs\.repository == github\.repository/)
    assert.match(save, /inputs\.ref == github\.ref_name/)
    assert.doesNotMatch(save, /github\.event_name == 'pull_request/)
  }
  assert.match(WORKFLOW, /push:\n {4}branches: \[main\]/)
  assert.ok(WORKFLOW.includes(`github.event_name == 'push' && '${JSON.stringify(SPEECH_PACKAGES)}'`))
  assert.ok(WORKFLOW.includes("overrides: ${{ inputs.overrides || '{}' }}"))
})

test('compiler cache restores compatible entries and saves a refreshed key', () => {
  const restore = step('Get ccache cache')
  assert.match(restore, /actions\/cache\/restore@/)
  assert.match(restore, /env\.CCACHE_DIR/)
  assert.match(restore, /env\.TOOLCHAIN_FINGERPRINT/)
  assert.match(restore, /github\.run_id.*github\.run_attempt/)
  assert.match(restore, /restore-keys:/)
  assert.match(step('Save ccache (trusted contexts)'), /steps\.ccache-cache\.outputs\.cache-primary-key/)
  assert.ok(WORKFLOW.indexOf('Configure C++ build resources') < WORKFLOW.indexOf('Get ccache cache'))
  for (const name of SPEECH_PACKAGES) {
    const config = JSON.parse(readFileSync(join(ROOT, `packages/${name}/project.json`), 'utf8')).targets['test:cpp'].options.ci
    assert.equal(config.hasCcache, true, name)
    assert.equal(config.cppBuildJobs, 2, name)
  }
})

test('ASR and BCI failures reach the merge guard and retain diagnostic artifacts', () => {
  for (const name of ['asr-ggml', 'bci-whispercpp']) {
    const config = JSON.parse(readFileSync(join(ROOT, `packages/${name}/project.json`), 'utf8')).targets['test:cpp'].options.ci
    assert.equal(config.continueOnError, false, name)
    assert.ok(CPP_TEST_KEYS.includes(name), name)
  }
  const body = step('Run C++ tests').split('        run: |\n')[1]
    .split('\n').filter((line) => line.startsWith('          ')).map((line) => line.slice(10)).join('\n')
  const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', `npm() { return 134; }\n${body}`], { encoding: 'utf8' })
  assert.equal(result.status, 134, result.stderr)
  for (const name of ['Generate Coverage Report', 'Archive Coverage Results']) {
    assert.match(step(name), /always\(\).*steps\.cpp-build\.outcome == 'success'/)
  }
})
