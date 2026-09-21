'use strict'

const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

// The fuzz target does NOT link @qvac/fabric, so — unlike addon-test — it keeps
// full ASan + LeakSanitizer: any leak or alloc/dealloc mismatch is a real
// finding. Keeping ASan strict is the whole reason the target skips fabric, so
// the posture is set explicitly and echoed rather than left to whatever the
// environment happens to carry. See buildRunnerEnv below.
//
// Usage:
//   node scripts/run-cpp-fuzz.js                     bounded unit-test mode (CI-friendly)
//   node scripts/run-cpp-fuzz.js --continuous        coverage-guided fuzzing (requires a
//                                                     -D FUZZTEST_FUZZING_MODE=ON build)
//   node scripts/run-cpp-fuzz.js --continuous <Suite.Test>
//   node scripts/run-cpp-fuzz.js --continuous --fuzz_for=30m   time-boxed
//
// Bounded mode runs every FUZZ_TEST in the binary. Coverage-guided mode fuzzes
// one at a time, so the second target needs an explicit selector:
//   npm run fuzz:continuous -- PreprocessorFuzz.PreprocessRawNeverCrashes
//
// Only --continuous and --build-dir are the runner's own. Every other flag is
// forwarded verbatim to the fuzz binary, which is how FuzzTest/libFuzzer knobs
// (--fuzz_for, --rss_limit_mb, --gtest_filter, ...) are reached. Through npm:
//   npm run fuzz:continuous -- --fuzz_for=30m
const DEFAULT_FUZZ_TEST = 'PreprocessorFuzz.PreprocessDecodedNeverCrashes'
const BINARY_NAME = 'preprocess-fuzz'

// Strict counterpart to run-cpp-tests.js's relaxed fabric-boundary string.
// detect_leaks=1 is already ASan's Linux default; it is spelled out so the
// posture is greppable in a log and so a future edit has to be deliberate.
const DEFAULT_ASAN_OPTIONS = 'detect_leaks=1:abort_on_error=1'

/**
 * Build the child-process env. Mirrors run-cpp-tests.js: an ASAN_OPTIONS
 * already in the environment — including an explicit empty string — is used
 * as-is, because overriding a caller's sanitizer choice is worse than honoring
 * it. Unlike that runner, ours is the strict default, so an inherited value is
 * usually accidental rather than intended; asanOptionsNotice() exists to make
 * that case loud.
 */
function buildRunnerEnv(processEnv) {
  return {
    ...processEnv,
    ASAN_OPTIONS: 'ASAN_OPTIONS' in processEnv ? processEnv.ASAN_OPTIONS : DEFAULT_ASAN_OPTIONS
  }
}

/**
 * Warning text for an inherited ASAN_OPTIONS, or null when we own the value.
 * ASan replaces its defaults with the string wholesale, so inheriting one from
 * a neighbouring addon-test session (or a job-level env block) silently drops
 * whatever it omits — LeakSanitizer above all.
 */
function asanOptionsNotice(processEnv) {
  if (!('ASAN_OPTIONS' in processEnv)) {
    return null
  }
  const inherited = processEnv.ASAN_OPTIONS
  const leaksOff = /(^|[:\s,])detect_leaks=0([:\s,]|$)/.test(inherited)
  return [
    `WARNING: ${BINARY_NAME} inherited ASAN_OPTIONS='${inherited}' instead of using`,
    `its default '${DEFAULT_ASAN_OPTIONS}'. ASan takes that string wholesale, so`,
    leaksOff
      ? 'LeakSanitizer is OFF for this run and leak findings will be missed.'
      : 'anything the default enables and this string omits is off for this run.',
    'Unset ASAN_OPTIONS to fuzz at full strength.'
  ].join('\n')
}

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
  const env = buildRunnerEnv(process.env)

  const notice = asanOptionsNotice(process.env)
  if (notice) {
    console.warn(notice)
  }
  // Always on the record: a run with LSan off is otherwise indistinguishable
  // from a run that found no leaks.
  console.log(`${BINARY_NAME}: ASAN_OPTIONS=${env.ASAN_OPTIONS}`)

  const result = spawnSync(binary, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
    env
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

module.exports = {
  parseArgs,
  buildFuzzArgs,
  buildRunnerEnv,
  asanOptionsNotice,
  resolveExitCode,
  DEFAULT_FUZZ_TEST,
  DEFAULT_ASAN_OPTIONS
}
