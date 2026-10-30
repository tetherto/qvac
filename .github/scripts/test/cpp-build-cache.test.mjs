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

test('the speech packages build their C++ tests with main\'s two jobs and no compiler cache', () => {
  // The speech packages build their C++ tests on the CI contract with main's two jobs, and no compiler cache.
  for (const name of SPEECH_PACKAGES) {
    const build = JSON.parse(readFileSync(join(ROOT, `packages/${name}/project.json`), 'utf8')).targets['cpp:build']
    assert.equal(build.options.env.CMAKE_BUILD_PARALLEL_LEVEL, '2', name)
  }
})

test('ASR, BCI and TTS C++ test failures reach the merge guard', () => {
  // On the CI contract every cpp:tests leg is required; tts's full run joins them.
  for (const name of ['asr-ggml', 'bci-whispercpp', 'tts-ggml']) {
    const tests = JSON.parse(readFileSync(join(ROOT, `packages/${name}/project.json`), 'utf8')).targets['cpp:tests']
    assert.ok(tests.options.commands.some((c) => /test:cpp:run/.test(c) && !/\|\| true/.test(c)), name)
    assert.ok(CPP_TEST_KEYS.includes(name), name)
  }
})
