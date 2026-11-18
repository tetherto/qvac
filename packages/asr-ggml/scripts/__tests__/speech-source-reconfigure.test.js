'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const cmake = require('cmake-runtime')()
const ninja = require('ninja-runtime')()

const addonCmake = path.resolve(__dirname, '../../../../cmake/qvac-addon')

const project = `
cmake_minimum_required(VERSION 3.25)
project(SpeechPinTest LANGUAGES NONE)
set(APPLE OFF)
add_library(qvac-fabric::headers INTERFACE IMPORTED)
include(speech-engines.cmake)

# Observe the selected source without downloading the archive.
function(FetchContent_Declare dependency)
  cmake_parse_arguments(source "" "URL" "" \${ARGN})
  file(CONFIGURE OUTPUT selected-url.txt CONTENT "\${source_URL}")
endfunction()
function(FetchContent_MakeAvailable)
endfunction()

qvac_addon_speech_engines()
add_custom_target(report-pin ALL
  COMMAND "\${CMAKE_COMMAND}" -E cat "\${CMAKE_CURRENT_BINARY_DIR}/selected-url.txt"
)
`

function runCmake(args) {
  const result = spawnSync(cmake, args, { encoding: 'utf8' })
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr)
  return result.stdout
}

test('building an existing Ninja directory picks up a pin-only change', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-speech-pin-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const file of [
    'speech-engines.cmake',
    'speech-local-logging.patch',
    'speech-streaming-capability.patch'
  ]) {
    fs.copyFileSync(path.join(addonCmake, file), path.join(root, file))
  }
  fs.writeFileSync(path.join(root, 'CMakeLists.txt'), project)
  const manifestPath = path.join(root, 'speech-source.json')
  const manifest = JSON.parse(fs.readFileSync(path.join(addonCmake, 'speech-source.json'), 'utf8'))
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  fs.utimesSync(manifestPath, 0, 0)

  const build = path.join(root, 'build')
  runCmake(['-S', root, '-B', build, '-G', 'Ninja', `-DCMAKE_MAKE_PROGRAM=${ninja}`])
  assert.ok(runCmake(['--build', build]).includes(manifest.revision))

  const updatedRevision = 'updated-speech-revision'
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, revision: updatedRevision }))
  assert.ok(runCmake(['--build', build]).includes(updatedRevision))
})
