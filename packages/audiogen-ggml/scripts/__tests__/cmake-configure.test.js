'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const PACKAGE_ROOT = path.resolve(__dirname, '../..')
const CMAKE = process.env.CMAKE || 'cmake'

function prepareProject(root) {
  const source = path.join(root, 'packages/audiogen-ggml')
  const helper = path.join(root, 'cmake/qvac-addon')
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(helper, { recursive: true })
  fs.copyFileSync(path.join(PACKAGE_ROOT, 'CMakeLists.txt'), path.join(source, 'CMakeLists.txt'))
  fs.cpSync(path.join(PACKAGE_ROOT, 'addon'), path.join(source, 'addon'), { recursive: true })
  fs.copyFileSync(
    path.join(PACKAGE_ROOT, 'test/cmake/qvac-addon.cmake'),
    path.join(helper, 'qvac-addon.cmake')
  )
  fs.writeFileSync(
    path.join(root, 'GTestConfig.cmake'),
    'add_library(GTest::gtest_main INTERFACE IMPORTED)\n'
  )
  return source
}

function configureProject(t, testing) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-cmake-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = prepareProject(root)
  const result = spawnSync(
    CMAKE,
    [
      '-S',
      source,
      '-B',
      path.join(root, 'build'),
      `-DBUILD_TESTING=${testing}`,
      '-DBUILD_FUZZING=OFF',
      `-DGTest_DIR=${root}`,
      `-DQVAC_LIB_INFERENCE_ADDON_CPP_INCLUDE_DIRS=${root}`
    ],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`)
}

test('AudioGen configures tests with only npm Fabric targets available', (t) =>
  configureProject(t, 'ON'))
test('AudioGen configures without test targets', (t) => configureProject(t, 'OFF'))
