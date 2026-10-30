import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
const FINGERPRINT_ACTION = '.github/actions/vcpkg-toolchain-fingerprint/action.yml'
const VCPKG_VERSION_LINE = 'vcpkg package management program version 2026-10-01-fixture'
const LARGE_VERSION_NOTES = 'Additional version output\n'.repeat(100000)
const VCPKG_FAILURE_EXIT_CODE = 23

function fingerprintVersionOutput(versionOutput, exitCode = 0) {
  const source = readFileSync(join(ROOT, FINGERPRINT_ACTION), 'utf8').replaceAll('\r\n', '\n')
  const body = source.split('      run: |\n')[1].split('\n    - if:')[0]
    .split('\n').map((line) => line.slice(8)).join('\n')
  const directory = mkdtempSync(join(tmpdir(), 'toolchain-fingerprint-'))
  const output = join(directory, 'github-env')
  const versionFile = join(directory, 'version-output')
  try {
    writeFileSync(output, '')
    writeFileSync(versionFile, versionOutput)
    writeFileSync(join(directory, 'vcpkg'), '#!/usr/bin/env bash\ncat "$VERSION_OUTPUT_FILE"\nexit "$VERSION_EXIT_CODE"\n', { mode: 0o755 })
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', body], {
      encoding: 'utf8',
      env: { ...process.env, RUNNER_OS: 'Linux', CC: process.execPath, VCPKG_ROOT: directory,
        GITHUB_ENV: output, VERSION_OUTPUT_FILE: versionFile, VERSION_EXIT_CODE: String(exitCode) },
    })
    return { ...result, githubEnv: readFileSync(output, 'utf8') }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function expectedFingerprint() {
  const digest = createHash('sha256').update(process.version + '\nvcpkg=' + VCPKG_VERSION_LINE).digest('hex')
  return 'TOOLCHAIN_FINGERPRINT=' + digest.slice(0, 16) + '\n'
}

test('toolchain fingerprint uses the reported version line', () => {
  const result = fingerprintVersionOutput(VCPKG_VERSION_LINE + '\n')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.githubEnv, expectedFingerprint())
})

test('toolchain fingerprint consumes verbose version output without a broken pipe', () => {
  const result = fingerprintVersionOutput(VCPKG_VERSION_LINE + '\n' + LARGE_VERSION_NOTES)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.githubEnv, expectedFingerprint())
})

test('toolchain fingerprint rejects an empty version', () => {
  const result = fingerprintVersionOutput('')
  assert.equal(result.status, 1, result.stderr)
  assert.equal(result.githubEnv, '')
  assert.match(result.stdout, /printed nothing/)
})

test('toolchain fingerprint preserves version command failures', () => {
  const result = fingerprintVersionOutput(VCPKG_VERSION_LINE + '\n', VCPKG_FAILURE_EXIT_CODE)
  assert.equal(result.status, VCPKG_FAILURE_EXIT_CODE, result.stderr)
  assert.equal(result.githubEnv, '')
})

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

test('documented cpp-tests dispatch exercises matrix flattening and override validation', () => {
  const doc = readFileSync(join(ROOT, 'docs/ci/nx-ci-consolidation.md'), 'utf8')
  const overrides = doc.match(/-f overrides='([^']+)'/)[1]
  const action = readFileSync(join(ROOT, '.github/actions/nx-project-matrix/action.yml'), 'utf8').replaceAll('\r\n', '\n')
  const body = action.slice(action.lastIndexOf('      run: |\n') + '      run: |\n'.length)
    .split('\n').map((line) => line.slice(8)).join('\n')
  const directory = mkdtempSync(join(tmpdir(), 'cpp-dispatch-'))
  const output = join(directory, 'output')
  try {
    // Native Windows jq writes CRLF; Linux runners use LF.
    const jqWrapper = "jq() { command jq \"$@\" | tr -d '\\r'; }\n"
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', jqWrapper + body], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, INPUT_TARGET: 'test:cpp', INPUT_PACKAGES: '["diffusion-cpp"]',
        INPUT_OVERRIDES: overrides, INPUT_CONFIG_REF: 'HEAD', INPUT_BASE_REF: 'HEAD',
        INPUT_HEAD_REF: 'HEAD', GITHUB_OUTPUT: output.replaceAll('\\', '/') },
    })
    assert.equal(result.status, 0, result.stderr + result.stdout)
    const matrix = JSON.parse(readFileSync(output, 'utf8').match(/^matrix=(.+)$/m)[1])
    // One row per declared platform, each carrying the override.
    assert.equal(matrix.length, 3)
    assert.ok(matrix.every((row) => row.mode === 'standard' && row.needsSd2Model === true))
    assert.deepEqual(matrix.map((row) => row.platform).sort(), ['darwin', 'linux', 'win32'])
    assert.equal(matrix.find((row) => row.platform === 'linux').runner, 'qvac-ubuntu2404-x64')
    assert.equal(matrix.find((row) => row.platform === 'linux').arch, 'x64')
  } finally {
    rmSync(directory, { recursive: true, force: true })
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
  assert.match(WORKFLOW, /schedule:\n(?: {4}#.*\n)* {4}- cron: /)
  assert.ok(WORKFLOW.includes('packages: ${{ steps.warm.outputs.packages || inputs.packages }}'))
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
  // The speech packages build their C++ tests on the CI contract with main's two jobs, and no compiler cache.
  for (const name of SPEECH_PACKAGES) {
    const build = JSON.parse(readFileSync(join(ROOT, `packages/${name}/project.json`), 'utf8')).targets['cpp:build']
    assert.equal(build.options.env.CMAKE_BUILD_PARALLEL_LEVEL, '2', name)
  }
})

test('ASR and BCI failures reach the merge guard and retain diagnostic artifacts', () => {
  // On the CI contract every cpp:tests leg is required; tts's full run joins them.
  for (const name of ['asr-ggml', 'bci-whispercpp', 'tts-ggml']) {
    const tests = JSON.parse(readFileSync(join(ROOT, `packages/${name}/project.json`), 'utf8')).targets['cpp:tests']
    assert.ok(tests.options.commands.some((c) => /test:cpp:run/.test(c) && !/\|\| true/.test(c)), name)
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
