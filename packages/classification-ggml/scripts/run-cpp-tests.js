'use strict'

const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

// addon-test links AddressSanitizer but dynamically loads the non-ASan,
// -static-libstdc++ @qvac/fabric prebuild. Objects that cross that module
// boundary trip alloc-dealloc-mismatch, and fabric's long-lived runtime globals
// plus its dlopen'd ggml backends look like leaks at exit -- both fire after
// every test has already passed. Relax exactly those two checks, matching
// .github/workflows/cpp-tests-classification.yml. See test/unit/CMakeLists.txt
// for the full rationale.
const DEFAULT_ASAN_OPTIONS = 'alloc_dealloc_mismatch=0:detect_leaks=0:abort_on_error=1'

/**
 * Build the child-process env for addon-test. When ASAN_OPTIONS is absent, apply
 * DEFAULT_ASAN_OPTIONS for local runs. When it is present — including an explicit
 * empty string (ASAN_OPTIONS=) — that value is used as-is; we do not merge with or
 * patch the default string. Setting only ASAN_OPTIONS=abort_on_error=0 drops
 * alloc_dealloc_mismatch=0 and detect_leaks=0 unless you include them yourself.
 */
function buildRunnerEnv(processEnv) {
  return {
    ...processEnv,
    ASAN_OPTIONS: 'ASAN_OPTIONS' in processEnv ? processEnv.ASAN_OPTIONS : DEFAULT_ASAN_OPTIONS
  }
}

/**
 * Map spawnSync() output to the runner's process exit code. ASan with
 * abort_on_error=1 terminates via SIGABRT (status null); that must not be
 * treated as success.
 */
function resolveExitCode(result) {
  if (result.signal) {
    return 1
  }
  return result.status ?? 1
}

/**
 * Resolve which build tree holds addon-test. Defaults to build/, which is where
 * the tests-only and the combined tests+fuzz configures both land. A
 * `--build-dir <dir>` (or `--build-dir=<dir>`) flag wins over the CPP_BUILD_DIR
 * env var, which wins over the default.
 */
function resolveBuildDir(argv, processEnv) {
  const eq = argv.find((a) => a.startsWith('--build-dir='))
  if (eq) {
    return eq.slice('--build-dir='.length)
  }
  const idx = argv.indexOf('--build-dir')
  if (idx !== -1) {
    // Matching run-cpp-fuzz.js: refuse a missing value and refuse to consume a
    // following flag as the value. Falling back to the default tree here would
    // run a different build than the caller asked for and still report success.
    const next = argv[idx + 1]
    if (next === undefined || next.startsWith('--')) {
      throw new Error('--build-dir requires a directory (e.g. --build-dir build-fuzz)')
    }
    return next
  }
  return processEnv.CPP_BUILD_DIR || 'build'
}

function main() {
  const binary = os.platform() === 'win32' ? 'addon-test.exe' : './addon-test'
  const buildDir = resolveBuildDir(process.argv.slice(2), process.env)
  const cwd = path.resolve(__dirname, '..', buildDir, 'test', 'unit')

  const result = spawnSync(binary, ['--gtest_output=xml:cpp-test-results.xml'], {
    cwd,
    stdio: 'inherit',
    shell: false,
    env: buildRunnerEnv(process.env)
  })

  if (result.error) {
    throw result.error
  }

  if (result.signal) {
    console.error(`addon-test terminated by signal ${result.signal}`)
  }

  process.exit(resolveExitCode(result))
}

if (require.main === module) {
  main()
}

module.exports = {
  DEFAULT_ASAN_OPTIONS,
  buildRunnerEnv,
  resolveExitCode,
  resolveBuildDir
}
