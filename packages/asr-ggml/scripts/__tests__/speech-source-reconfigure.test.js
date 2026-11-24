'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const addonCmake = path.resolve(__dirname, '../../../../cmake/qvac-addon')
const ARCHIVE_MTIME = '2000-01-01 00:00:00'
const SOURCE_ARCHIVE_URL = 'https://github.com/${repository}/archive/${revision}.tar.gz'
const FIXTURE_ARCHIVE_PATH = '${CMAKE_CURRENT_FUNCTION_LIST_DIR}/${revision}.tar.gz'

const project = `
cmake_minimum_required(VERSION 3.25)
project(SpeechPinTest LANGUAGES C)
set(APPLE OFF)
add_library(qvac-fabric::headers INTERFACE IMPORTED)
include(speech-engines.cmake)
qvac_addon_speech_engines(parakeet)
add_executable(speech-fixture main.c)
target_link_libraries(speech-fixture PRIVATE fixture_speech)
`

const main = `
#include <stdio.h>

const char *revision(void);
const char *logging(void);
const char *capability(void);

int main(void) {
    printf("%s %s %s\\n", revision(), logging(), capability());
    return 0;
}
`

function prepareRuntime(binary) {
  if (process.platform !== 'win32') {
    try {
      fs.accessSync(binary, fs.constants.X_OK)
    } catch {
      fs.chmodSync(binary, 0o755)
    }
  }
  return binary
}

function run(binary, args, cwd) {
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr)
  return result.stdout.trim()
}

function functionSource(name, value) {
  return `const char *${name}(void) { return "${value}"; }\n`
}

function createArchive(cmake, root, revision) {
  const source = path.join(root, 'sources', revision)
  const engine = path.join(source, 'engines/parakeet')
  fs.mkdirSync(engine, { recursive: true })
  fs.writeFileSync(
    path.join(engine, 'CMakeLists.txt'),
    'add_library(fixture_speech STATIC revision.c logging.c capability.c)\n'
  )
  fs.writeFileSync(path.join(engine, 'revision.c'), functionSource('revision', revision))
  fs.writeFileSync(path.join(engine, 'logging.c'), functionSource('logging', 'unpatched'))
  fs.writeFileSync(path.join(engine, 'capability.c'), functionSource('capability', 'unpatched'))

  const archive = path.join(root, `${revision}.tar.gz`)
  run(
    cmake,
    ['-E', 'tar', 'czf', archive, `--mtime=${ARCHIVE_MTIME}`, revision],
    path.dirname(source)
  )
  return {
    repository: 'fixture/speech',
    revision,
    sha512: createHash('sha512').update(fs.readFileSync(archive)).digest('hex')
  }
}

function writePatch(root, file, symbol, value) {
  const source = `engines/parakeet/${symbol}.c`
  fs.writeFileSync(
    path.join(root, file),
    `--- a/${source}\n+++ b/${source}\n@@ -1 +1 @@\n-${functionSource(symbol, 'unpatched')}+${functionSource(symbol, value)}`
  )
}

test('the same Ninja build recompiles after a speech pin change or a patch change', (t) => {
  const cmake = prepareRuntime(require('cmake-runtime')())
  const ninja = prepareRuntime(require('ninja-runtime')())
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-speech-pin-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const helper = fs.readFileSync(path.join(addonCmake, 'speech-engines.cmake'), 'utf8')
  assert.ok(helper.includes(SOURCE_ARCHIVE_URL))
  fs.writeFileSync(
    path.join(root, 'speech-engines.cmake'),
    helper.replace(SOURCE_ARCHIVE_URL, FIXTURE_ARCHIVE_PATH)
  )
  fs.writeFileSync(path.join(root, 'CMakeLists.txt'), project)
  fs.writeFileSync(path.join(root, 'main.c'), main)

  const first = createArchive(cmake, root, 'first')
  const second = createArchive(cmake, root, 'second')
  const manifest = path.join(root, 'speech-source.json')
  const loggingPatch = 'speech-local-logging.patch'
  const streamingPatch = 'speech-streaming-capability.patch'
  fs.writeFileSync(manifest, JSON.stringify(first))
  writePatch(root, loggingPatch, 'logging', 'logging')
  writePatch(root, streamingPatch, 'capability', 'original')

  const build = path.join(root, 'build')
  run(cmake, ['-S', root, '-B', build, '-G', 'Ninja', `-DCMAKE_MAKE_PROGRAM=${ninja}`])
  const executable = path.join(
    build,
    process.platform === 'win32' ? 'speech-fixture.exe' : 'speech-fixture'
  )
  run(cmake, ['--build', build])
  assert.equal(run(executable, []), 'first logging original')

  fs.writeFileSync(manifest, JSON.stringify(second))
  run(cmake, ['--build', build])
  assert.equal(run(executable, []), 'second logging original')

  writePatch(root, streamingPatch, 'capability', 'updated')
  run(cmake, ['--build', build])
  assert.equal(run(executable, []), 'second logging updated')
})
