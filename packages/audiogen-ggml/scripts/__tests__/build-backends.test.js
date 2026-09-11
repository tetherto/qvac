'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const packageRoot = path.resolve(__dirname, '..', '..')
const cmakeSource = fs.readFileSync(path.join(packageRoot, 'CMakeLists.txt'), 'utf8')
const vcpkgManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'vcpkg.json'), 'utf8'))

const CUDA_OPTION = 'ENABLE_CUDA'
const CUDA_FEATURE = 'cuda'
const GGML_PORT = 'ggml-speech'
const SPEECH_PORT = 'speech-cpp'
const DESKTOP_PLATFORM = '!(osx | ios | android)'

function namedDependencies(dependencies, name) {
  return dependencies.filter((dependency) => dependency.name === name)
}

function cudaSpeechDependency() {
  return namedDependencies(vcpkgManifest.features[CUDA_FEATURE].dependencies, SPEECH_PORT)[0]
}

test('the CUDA build remains opt-in', () => {
  assert.match(cmakeSource, new RegExp(`option\\(${CUDA_OPTION} "[^"]+" OFF\\)`))
  assert.match(
    cmakeSource,
    new RegExp(
      `if\\(${CUDA_OPTION}\\)\\s*\\n\\s*list\\(APPEND VCPKG_MANIFEST_FEATURES "${CUDA_FEATURE}"\\)`
    )
  )
})

test('the CUDA feature targets supported desktop platforms', () => {
  const dependency = cudaSpeechDependency()

  assert.equal(vcpkgManifest.features[CUDA_FEATURE].supports, DESKTOP_PLATFORM)
  assert.deepEqual(dependency.features, [CUDA_FEATURE])
  assert.equal(dependency['default-features'], false)
  assert.equal(dependency.platform, DESKTOP_PLATFORM)
})

test('the hybrid backend dependency floors match the reviewed speech stack', () => {
  const ggmlDependency = namedDependencies(vcpkgManifest.dependencies, GGML_PORT)[0]
  const speechDependencies = namedDependencies(vcpkgManifest.dependencies, SPEECH_PORT)

  assert.equal(ggmlDependency['version>='], '2026-09-09#1')
  assert.equal(ggmlDependency['default-features'], false)
  assert.equal(cudaSpeechDependency()['version>='], '2026-09-11')
  assert.equal(
    speechDependencies.every((dependency) => dependency['version>='] === '2026-09-11'),
    true
  )
})

test('the Windows CUDA build stages runtime-loaded backend modules', () => {
  assert.match(cmakeSource, /\(WIN32 AND ENABLE_CUDA\)/)
  assert.match(cmakeSource, /qvac-speech-ggml-\*\.dll/)
  assert.equal(/CUDA::/.test(cmakeSource), false)
})
