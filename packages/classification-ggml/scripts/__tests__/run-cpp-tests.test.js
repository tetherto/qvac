'use strict'

/**
 * Regression tests for scripts/run-cpp-tests.js runner semantics.
 *
 * Run locally:
 *   npm run test:scripts
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { DEFAULT_ASAN_OPTIONS, buildRunnerEnv, resolveExitCode } = require('../run-cpp-tests')

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
  const env = buildRunnerEnv({})
  assert.equal(env.ASAN_OPTIONS, DEFAULT_ASAN_OPTIONS)
})

test('buildRunnerEnv replaces rather than merges explicit ASAN_OPTIONS', () => {
  const override = 'abort_on_error=0'
  const env = buildRunnerEnv({ ASAN_OPTIONS: override })
  assert.equal(env.ASAN_OPTIONS, override)
  assert.notEqual(env.ASAN_OPTIONS, DEFAULT_ASAN_OPTIONS)
})

test('buildRunnerEnv preserves an explicit empty ASAN_OPTIONS', () => {
  const env = buildRunnerEnv({ ASAN_OPTIONS: '' })
  assert.equal(env.ASAN_OPTIONS, '')
})
