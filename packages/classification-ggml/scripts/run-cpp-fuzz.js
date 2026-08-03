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
const DEFAULT_FUZZ_TEST = 'PreprocessorFuzz.PreprocessDecodedNeverCrashes'
const BINARY_NAME = 'preprocess-fuzz'

function parseArgs(argv) {
  const continuous = argv.includes('--continuous')
  // --build-dir <dir> / --build-dir=<dir> selects the build tree; everything
  // else non-flag is the optional Suite.Test selector.
  let buildDir
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--build-dir=')) {
      buildDir = a.slice('--build-dir='.length)
    } else if (a === '--build-dir') {
      buildDir = argv[++i]
    } else if (!a.startsWith('--')) {
      rest.push(a)
    }
  }
  const fuzzTest = rest[0] || DEFAULT_FUZZ_TEST
  return { continuous, fuzzTest, buildDir }
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
  const { continuous, fuzzTest, buildDir } = parseArgs(process.argv.slice(2))
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

  const args = continuous ? [`--fuzz=${fuzzTest}`] : []

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

module.exports = { parseArgs, resolveExitCode, DEFAULT_FUZZ_TEST }
