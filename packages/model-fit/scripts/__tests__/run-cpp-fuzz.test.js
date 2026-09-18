'use strict'

/**
 * Regression tests for scripts/run-cpp-fuzz.js argument parsing.
 *
 * Run locally:
 *   npm run test:scripts
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_FUZZ_TEST,
  DEFAULT_ASAN_OPTIONS,
  parseArgs,
  buildFuzzArgs,
  buildRunnerEnv,
  asanOptionsNotice,
  resolveExitCode
} = require('../run-cpp-fuzz')

test('parseArgs defaults to bounded mode and the default fuzz test', () => {
  assert.deepEqual(parseArgs([]), {
    continuous: false,
    fuzzTest: DEFAULT_FUZZ_TEST,
    buildDir: undefined,
    fuzzerArgs: []
  })
})

test('parseArgs enables continuous mode and accepts a fuzz test selector', () => {
  assert.deepEqual(parseArgs(['--continuous', 'OtherSuite.OtherProperty']), {
    continuous: true,
    fuzzTest: 'OtherSuite.OtherProperty',
    buildDir: undefined,
    fuzzerArgs: []
  })
})

test('parseArgs supports both build-dir flag forms', () => {
  assert.deepEqual(parseArgs(['--build-dir', 'build-fuzz']), {
    continuous: false,
    fuzzTest: DEFAULT_FUZZ_TEST,
    buildDir: 'build-fuzz',
    fuzzerArgs: []
  })
  assert.deepEqual(parseArgs(['--build-dir=build-fuzz']), {
    continuous: false,
    fuzzTest: DEFAULT_FUZZ_TEST,
    buildDir: 'build-fuzz',
    fuzzerArgs: []
  })
})

test('parseArgs keeps the build directory separate from the fuzz selector', () => {
  assert.deepEqual(
    parseArgs(['--continuous', '--build-dir', 'build-fuzz', 'OtherSuite.OtherProperty']),
    {
      continuous: true,
      fuzzTest: 'OtherSuite.OtherProperty',
      buildDir: 'build-fuzz',
      fuzzerArgs: []
    }
  )
})

test('parseArgs forwards unrecognized flags to the fuzz binary', () => {
  assert.deepEqual(parseArgs(['--continuous', '--fuzz_for=30m', '--rss_limit_mb=4096']), {
    continuous: true,
    fuzzTest: DEFAULT_FUZZ_TEST,
    buildDir: undefined,
    fuzzerArgs: ['--fuzz_for=30m', '--rss_limit_mb=4096']
  })
})

test('parseArgs does not forward its own flags to the fuzz binary', () => {
  const { fuzzerArgs } = parseArgs([
    '--continuous',
    '--build-dir',
    'build-fuzz',
    '--build-dir=build-other'
  ])
  assert.deepEqual(fuzzerArgs, [])
})

test('parseArgs rejects a build-dir that would swallow a forwarded flag', () => {
  assert.throws(() => parseArgs(['--build-dir', '--fuzz_for=30m']), /--build-dir requires/)
  assert.throws(() => parseArgs(['--continuous', '--build-dir']), /--build-dir requires/)
})

test('buildFuzzArgs selects the fuzz test in continuous mode', () => {
  assert.deepEqual(
    buildFuzzArgs({ continuous: true, fuzzTest: 'Suite.Test', fuzzerArgs: ['--fuzz_for=30m'] }),
    ['--fuzz=Suite.Test', '--fuzz_for=30m']
  )
})

test('buildFuzzArgs omits the fuzz selector in bounded mode but keeps forwarded flags', () => {
  assert.deepEqual(
    buildFuzzArgs({ continuous: false, fuzzTest: 'Suite.Test', fuzzerArgs: ['--gtest_filter=X*'] }),
    ['--gtest_filter=X*']
  )
})

test('buildFuzzArgs places forwarded flags after the fuzz selector', () => {
  assert.deepEqual(
    buildFuzzArgs({
      continuous: true,
      fuzzTest: DEFAULT_FUZZ_TEST,
      fuzzerArgs: ['--fuzz=Other.T']
    }),
    [`--fuzz=${DEFAULT_FUZZ_TEST}`, '--fuzz=Other.T']
  )
})

test('buildRunnerEnv keeps ASan strict when the environment says nothing', () => {
  const env = buildRunnerEnv({ PATH: '/usr/bin' })
  assert.equal(env.ASAN_OPTIONS, DEFAULT_ASAN_OPTIONS)
  assert.match(env.ASAN_OPTIONS, /detect_leaks=1/)
  assert.equal(env.PATH, '/usr/bin')
})

test('buildRunnerEnv honours an inherited ASAN_OPTIONS as-is', () => {
  const inherited = 'alloc_dealloc_mismatch=0:detect_leaks=0:abort_on_error=1'
  assert.equal(buildRunnerEnv({ ASAN_OPTIONS: inherited }).ASAN_OPTIONS, inherited)
  assert.equal(buildRunnerEnv({ ASAN_OPTIONS: '' }).ASAN_OPTIONS, '')
})

test('asanOptionsNotice stays quiet when the runner owns the value', () => {
  assert.equal(asanOptionsNotice({ PATH: '/usr/bin' }), null)
})

test('asanOptionsNotice calls out an inherited value that disables LeakSanitizer', () => {
  const notice = asanOptionsNotice({
    ASAN_OPTIONS: 'alloc_dealloc_mismatch=0:detect_leaks=0:abort_on_error=1'
  })
  assert.match(notice, /^WARNING:/)
  assert.match(notice, /LeakSanitizer is OFF/)
  assert.match(notice, /detect_leaks=0/)
})

test('asanOptionsNotice warns about any inherited value, not just detect_leaks=0', () => {
  const notice = asanOptionsNotice({ ASAN_OPTIONS: 'abort_on_error=0' })
  assert.match(notice, /^WARNING:/)
  assert.doesNotMatch(notice, /LeakSanitizer is OFF/)
})

test('asanOptionsNotice does not mistake detect_leaks=1 for the disabled form', () => {
  const notice = asanOptionsNotice({ ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=0' })
  assert.doesNotMatch(notice, /LeakSanitizer is OFF/)
})

test('resolveExitCode preserves a non-zero fuzz failure', () => {
  assert.equal(resolveExitCode({ status: 1 }), 1)
})

test('resolveExitCode preserves a successful fuzz run', () => {
  assert.equal(resolveExitCode({ status: 0 }), 0)
})

test('resolveExitCode maps signal termination to failure', () => {
  assert.equal(resolveExitCode({ signal: 'SIGABRT', status: null }), 1)
})

test('resolveExitCode maps a null status without a signal to failure', () => {
  assert.equal(resolveExitCode({ status: null }), 1)
})

test('resolveExitCode rethrows a spawn error', () => {
  const error = new Error('spawn failed')
  assert.throws(() => resolveExitCode({ error }), error)
})
