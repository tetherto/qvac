'use strict'

const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

// The fuzz target does NOT link @qvac/fabric, so — unlike addon-test — it keeps
// full ASan + LeakSanitizer. We deliberately do not relax any ASAN_OPTIONS
// here: any leak or alloc/dealloc mismatch is a real finding.
//
// Usage:
//   node scripts/run-cpp-fuzz.js                     bounded unit-test mode (CI-friendly)
//   node scripts/run-cpp-fuzz.js --continuous        coverage-guided fuzzing (requires a
//                                                     -D FUZZTEST_FUZZING_MODE=ON build)
//   node scripts/run-cpp-fuzz.js --continuous <Suite.Test>
//   node scripts/run-cpp-fuzz.js --continuous --fuzz_for=30m   time-boxed
//
// Only --continuous and --build-dir are the runner's own. Every other flag is
// forwarded verbatim to the fuzz binary, which is how FuzzTest/libFuzzer knobs
// (--fuzz_for, --rss_limit_mb, --gtest_filter, ...) are reached. Through npm:
//   npm run fuzz:continuous -- --fuzz_for=30m
const DEFAULT_FUZZ_TEST = 'PreprocessorFuzz.PreprocessDecodedNeverCrashes'
const BINARY_NAME = 'preprocess-fuzz'

function parseArgs(argv) {
  // --build-dir <dir> / --build-dir=<dir> selects the build tree; a non-flag is
  // the optional Suite.Test selector; anything else is the binary's.
  let continuous = false
  let buildDir
  const rest = []
  const fuzzerArgs = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--continuous') {
      continuous = true
    } else if (a.startsWith('--build-dir=')) {
      buildDir = a.slice('--build-dir='.length)
    } else if (a === '--build-dir') {
      // Refuse to consume a following flag as the value — that would silently
      // swallow a flag the binary was meant to receive.
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error('--build-dir requires a directory (e.g. --build-dir build-fuzz)')
      }
      buildDir = next
      i++
    } else if (a.startsWith('--')) {
      // Unknown to us, so it belongs to the fuzz binary. Forwarding beats an
      // allowlist: the binary's own flag parser rejects what it doesn't know, so
      // a typo fails loudly instead of being dropped on the floor.
      fuzzerArgs.push(a)
    } else {
      rest.push(a)
    }
  }
  const fuzzTest = rest[0] || DEFAULT_FUZZ_TEST
  return { continuous, fuzzTest, buildDir, fuzzerArgs }
}

/**
 * Assemble the fuzz binary's argv. The `--fuzz=` selector goes first so a
 * forwarded `--fuzz=...` lands after it and wins (last occurrence of a flag is
 * the one the binary keeps).
 */
function buildFuzzArgs({ continuous, fuzzTest, fuzzerArgs = [] }) {
  return continuous ? [`--fuzz=${fuzzTest}`, ...fuzzerArgs] : [...fuzzerArgs]
}

function resolveExitCode(result) {
  if (result.error) {
    throw result.error
  }
  if (result.signal) {
    return 1
  }
  return result.status ?? 1
}

function main() {
  const { continuous, fuzzTest, buildDir, fuzzerArgs } = parseArgs(process.argv.slice(2))
  const binary = os.platform() === 'win32' ? `${BINARY_NAME}.exe` : `./${BINARY_NAME}`
  // Every configure of this package shares the default build/ tree; the fuzz
  // scripts just pass a different -D set. --build-dir stays available for a
  // side-by-side tree.
  const cwd = path.resolve(
    __dirname,
    '..',
    buildDir || process.env.CPP_BUILD_DIR || 'build',
    'test',
    'fuzz'
  )

  const args = buildFuzzArgs({ continuous, fuzzTest, fuzzerArgs })

  const result = spawnSync(binary, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
    env: process.env
  })

  const exitCode = resolveExitCode(result)
  if (result.signal) {
    console.error(`${BINARY_NAME} terminated by signal ${result.signal}`)
  }
  process.exit(exitCode)
}

if (require.main === module) {
  main()
}

module.exports = { parseArgs, buildFuzzArgs, resolveExitCode, DEFAULT_FUZZ_TEST }
