#!/usr/bin/env node
'use strict'

const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const { ensureUnitTestModels } = require('./download-unit-test-models')

// addon-test links AddressSanitizer but dynamically loads the non-ASan,
// -static-libstdc++ @qvac/fabric prebuild. Objects that cross that module
// boundary trip alloc-dealloc-mismatch, and fabric's long-lived runtime globals
// plus its dlopen'd ggml backends look like leaks at exit -- both fire after
// every test has already passed. Relax exactly those two checks. See
// test/unit/CMakeLists.txt for the full rationale.
const DEFAULT_ASAN_OPTIONS = 'alloc_dealloc_mismatch=0:detect_leaks=0:abort_on_error=1'

function parseArgs(argv) {
  const flags = new Set(['--coverage', '--ci'])
  const coverage = argv.includes('--coverage')
  const ciOnly = argv.includes('--ci')
  const gtestArgs = argv.filter((arg) => !flags.has(arg))
  return { coverage, ciOnly, gtestArgs }
}

/**
 * Build the child-process env for addon-test. When ASAN_OPTIONS is absent, apply
 * DEFAULT_ASAN_OPTIONS. When it is present — including an explicit empty string
 * (ASAN_OPTIONS=) — that value is used as-is; we do not merge with or patch the
 * default string. Setting only ASAN_OPTIONS=abort_on_error=0 drops
 * alloc_dealloc_mismatch=0 and detect_leaks=0 unless you include them yourself.
 *
 * LSAN_OPTIONS keeps pointing at the checked-in suppressions file so a caller
 * that re-enables detect_leaks still gets them; it is inert while the default
 * ASAN_OPTIONS turns LeakSanitizer off.
 */
function buildRunnerEnv(processEnv, projectRoot, { coverage = false } = {}) {
  const env = {
    ...processEnv,
    ASAN_OPTIONS: 'ASAN_OPTIONS' in processEnv ? processEnv.ASAN_OPTIONS : DEFAULT_ASAN_OPTIONS,
    LSAN_OPTIONS:
      'LSAN_OPTIONS' in processEnv
        ? processEnv.LSAN_OPTIONS
        : `suppressions=${path.join(projectRoot, '.lsan-suppressions.txt')}`
  }
  if (coverage) {
    // Same as pre-refactor: run from build/test/unit with default.profraw
    env.LLVM_PROFILE_FILE = env.LLVM_PROFILE_FILE || 'default.profraw'
  }
  return env
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

async function main() {
  const { coverage, ciOnly, gtestArgs } = parseArgs(process.argv.slice(2))

  await ensureUnitTestModels({ ciOnly })

  const projectRoot = path.resolve(__dirname, '..')
  const cwd = path.join(projectRoot, 'build', 'test', 'unit')
  const binaryName = os.platform() === 'win32' ? 'addon-test.exe' : 'addon-test'
  const binary = path.join(cwd, binaryName)

  const result = spawnSync(binary, ['--gtest_output=xml:cpp-test-results.xml', ...gtestArgs], {
    cwd,
    stdio: 'inherit',
    shell: false,
    env: buildRunnerEnv(process.env, projectRoot, { coverage })
  })

  if (result.error) {
    throw result.error
  }

  if (result.signal) {
    console.error(`addon-test killed by signal ${result.signal}`)
  }

  process.exit(resolveExitCode(result))
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err)
    process.exit(1)
  })
}

module.exports = {
  DEFAULT_ASAN_OPTIONS,
  parseArgs,
  buildRunnerEnv,
  resolveExitCode
}
