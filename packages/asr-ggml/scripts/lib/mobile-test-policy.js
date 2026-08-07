'use strict'

// Shared policy for the mobile integration bundle, consumed by
// scripts/generate-mobile-integration-tests.js and
// scripts/validate-mobile-tests.js so the generator and the validator can
// never disagree about which cases belong on a device.

// Integration tests that cannot run inside the mobile bundle. The mobile
// bundler resolves a test's imports against the package's EXPORTS, so a
// relative require that escapes test/ only works when it maps to an exported
// subpath: `../../binding` does, `../../engines/whisper/whisper.js` does not,
// and the build dies with MODULE_NOT_FOUND. These cases also spawn
// subprocesses via bare-subprocess, which is meaningless on a device.
const DESKTOP_ONLY = new Set([
  'addon.test.js'
])

// Cases forced to the END of the emitted module, after the alphabetical block.
// Whisper's GPU teardown can crash the bare app on some Adreno devices at
// process/context shutdown (whisper.cpp#2373); keeping these last means such a
// crash cannot drop coverage of any earlier case. Encoded here rather than
// hand-edited into the generated file, so regenerating preserves the ordering.
const RUN_LAST = [
  'mobile-perf-sweep-gpu.test.js',
  'mobile-perf-tiny-gpu.test.js'
]

function orderIntegrationFiles (files) {
  const last = files.filter(f => RUN_LAST.includes(f))
    .sort((a, b) => RUN_LAST.indexOf(a) - RUN_LAST.indexOf(b))
  const rest = files.filter(f => !RUN_LAST.includes(f)).sort()
  return [...rest, ...last]
}

module.exports = { DESKTOP_ONLY, RUN_LAST, orderIntegrationFiles }
