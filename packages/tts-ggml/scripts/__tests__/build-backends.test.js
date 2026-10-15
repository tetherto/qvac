'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const packageRoot = path.resolve(__dirname, '..', '..')
const cmakeSource = fs.readFileSync(path.join(packageRoot, 'CMakeLists.txt'), 'utf8')
const projectJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'project.json'), 'utf8'))

const CUDA_OPTION = 'ENABLE_CUDA'
const PUBLISHED_CUDA_HOST = 'linux-x64'

function publishBuildCi() {
  return projectJson.targets.build.options.ci
}

function platformDefines(host) {
  const entry = (publishBuildCi().platformCmakeDefines ?? '')
    .split('\n')
    .find((line) => line.trim().startsWith(`${host}:`))
  return entry === undefined ? '' : entry.slice(entry.indexOf(':') + 1).trim()
}

test('the CUDA build stays an opt-in CMake option', () => {
  assert.match(cmakeSource, new RegExp(`option\\(${CUDA_OPTION} "[^"]+" OFF\\)`))
})

test('the published linux-x64 prebuild builds the CUDA backend', () => {
  assert.equal(publishBuildCi().includeCuda, true)
  assert.match(platformDefines(PUBLISHED_CUDA_HOST), new RegExp(`-D ${CUDA_OPTION}=ON`))
})
