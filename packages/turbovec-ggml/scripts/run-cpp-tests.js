'use strict'

// Runs addon-test from the tests configure and writes its JUnit report.

const path = require('path')
const { spawnSync } = require('child_process')

// addon-test links AddressSanitizer but dynamically loads the non-ASan
// @qvac/fabric prebuild. Objects that cross that module boundary trip
// alloc-dealloc-mismatch, and fabric's long-lived runtime globals look like
// leaks at exit. Relax exactly those two checks unless the caller sets
// ASAN_OPTIONS. See test/unit/CMakeLists.txt.
const DEFAULT_ASAN_OPTIONS = 'alloc_dealloc_mismatch=0:detect_leaks=0:abort_on_error=1'

const binary = process.platform === 'win32' ? 'addon-test.exe' : './addon-test'
const cwd = path.resolve(__dirname, '..', 'build', 'test', 'unit')

const result = spawnSync(binary, ['--gtest_output=xml:cpp-test-results.xml'], {
  cwd,
  stdio: 'inherit',
  shell: false,
  env: {
    ...process.env,
    ASAN_OPTIONS: 'ASAN_OPTIONS' in process.env ? process.env.ASAN_OPTIONS : DEFAULT_ASAN_OPTIONS
  }
})

if (result.error) throw result.error
if (result.signal) {
  console.error(`addon-test terminated by signal ${result.signal}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
