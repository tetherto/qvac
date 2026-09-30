'use strict'

/**
 * Regression tests for scripts/run-cpp-tests.js runner semantics.
 *
 * Run locally:
 *   npm run test:prestage
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const {
  DEFAULT_ASAN_OPTIONS,
  parseArgs,
  buildRunnerEnv,
  resolveExitCode
} = require('../run-cpp-tests')

const PROJECT_ROOT = '/pkg/llm-llamacpp'

test('resolveExitCode maps a normal gtest failure to a non-zero exit', () => {
  assert.equal(resolveExitCode({ status: 1 }), 1)
})

test('resolveExitCode maps success to exit 0', () => {
  assert.equal(resolveExitCode({ status: 0 }), 0)
})

test('resolveExitCode maps ASan SIGABRT (null status) to failure, not exit 0', () => {
  assert.equal(resolveExitCode({ signal: 'SIGABRT', status: null }), 1)
})

test('resolveExitCode maps null status without a signal to failure', () => {
  assert.equal(resolveExitCode({ status: null }), 1)
})

test('buildRunnerEnv applies DEFAULT_ASAN_OPTIONS when unset', () => {
  const env = buildRunnerEnv({}, PROJECT_ROOT)
  assert.equal(env.ASAN_OPTIONS, DEFAULT_ASAN_OPTIONS)
})

test('buildRunnerEnv replaces rather than merges explicit ASAN_OPTIONS', () => {
  const override = 'abort_on_error=0'
  const env = buildRunnerEnv({ ASAN_OPTIONS: override }, PROJECT_ROOT)
  assert.equal(env.ASAN_OPTIONS, override)
  assert.notEqual(env.ASAN_OPTIONS, DEFAULT_ASAN_OPTIONS)
})

test('buildRunnerEnv preserves an explicit empty ASAN_OPTIONS', () => {
  const env = buildRunnerEnv({ ASAN_OPTIONS: '' }, PROJECT_ROOT)
  assert.equal(env.ASAN_OPTIONS, '')
})

test('buildRunnerEnv points LSAN_OPTIONS at the checked-in suppressions file', () => {
  const env = buildRunnerEnv({}, PROJECT_ROOT)
  assert.equal(
    env.LSAN_OPTIONS,
    `suppressions=${path.join(PROJECT_ROOT, '.lsan-suppressions.txt')}`
  )
})

test('buildRunnerEnv preserves an explicit LSAN_OPTIONS', () => {
  const env = buildRunnerEnv({ LSAN_OPTIONS: 'suppressions=/tmp/mine.txt' }, PROJECT_ROOT)
  assert.equal(env.LSAN_OPTIONS, 'suppressions=/tmp/mine.txt')
})

test('buildRunnerEnv sets LLVM_PROFILE_FILE only under coverage', () => {
  assert.equal(buildRunnerEnv({}, PROJECT_ROOT).LLVM_PROFILE_FILE, undefined)
  assert.equal(
    buildRunnerEnv({}, PROJECT_ROOT, { coverage: true }).LLVM_PROFILE_FILE,
    'default.profraw'
  )
})

test('buildRunnerEnv preserves an explicit LLVM_PROFILE_FILE under coverage', () => {
  const env = buildRunnerEnv({ LLVM_PROFILE_FILE: 'mine.profraw' }, PROJECT_ROOT, {
    coverage: true
  })
  assert.equal(env.LLVM_PROFILE_FILE, 'mine.profraw')
})

test('parseArgs separates runner flags from gtest passthrough args', () => {
  const { coverage, ciOnly, gtestArgs } = parseArgs([
    '--coverage',
    '--ci',
    '--gtest_filter=LlamaModelTest.*'
  ])
  assert.equal(coverage, true)
  assert.equal(ciOnly, true)
  assert.deepEqual(gtestArgs, ['--gtest_filter=LlamaModelTest.*'])
})

test('parseArgs defaults both runner flags to off', () => {
  const { coverage, ciOnly, gtestArgs } = parseArgs([])
  assert.equal(coverage, false)
  assert.equal(ciOnly, false)
  assert.deepEqual(gtestArgs, [])
})
