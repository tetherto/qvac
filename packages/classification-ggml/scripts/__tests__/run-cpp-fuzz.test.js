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
  parseArgs
} = require('../run-cpp-fuzz')

test('parseArgs defaults to bounded mode and the default fuzz test', () => {
  assert.deepEqual(parseArgs([]), {
    continuous: false,
    fuzzTest: DEFAULT_FUZZ_TEST,
    buildDir: undefined
  })
})

test('parseArgs enables continuous mode and accepts a fuzz test selector', () => {
  assert.deepEqual(
    parseArgs(['--continuous', 'OtherSuite.OtherProperty']),
    {
      continuous: true,
      fuzzTest: 'OtherSuite.OtherProperty',
      buildDir: undefined
    }
  )
})

test('parseArgs supports both build-dir flag forms', () => {
  assert.deepEqual(
    parseArgs(['--build-dir', 'build-fuzz']),
    {
      continuous: false,
      fuzzTest: DEFAULT_FUZZ_TEST,
      buildDir: 'build-fuzz'
    }
  )
  assert.deepEqual(
    parseArgs(['--build-dir=build-fuzz']),
    {
      continuous: false,
      fuzzTest: DEFAULT_FUZZ_TEST,
      buildDir: 'build-fuzz'
    }
  )
})

test('parseArgs keeps the build directory separate from the fuzz selector', () => {
  assert.deepEqual(
    parseArgs([
      '--continuous',
      '--build-dir',
      'build-fuzz',
      'OtherSuite.OtherProperty'
    ]),
    {
      continuous: true,
      fuzzTest: 'OtherSuite.OtherProperty',
      buildDir: 'build-fuzz'
    }
  )
})
