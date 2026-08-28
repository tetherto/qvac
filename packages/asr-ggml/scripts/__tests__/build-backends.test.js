'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const packageRoot = path.resolve(__dirname, '..', '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const vcpkgManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'vcpkg.json'), 'utf8'))
const cmakeSource = fs.readFileSync(path.join(packageRoot, 'CMakeLists.txt'), 'utf8')
const whisperModelSource = fs.readFileSync(
  path.join(packageRoot, 'addon/src/model-interface/whisper/WhisperModel.cpp'),
  'utf8'
)

const CUDA_CMAKE_OPTION = 'ASR_CUDA'
const CUDA_MANIFEST_FEATURE = 'cuda'
const SPEECH_PORT = 'speech-cpp'
const DESKTOP_PLATFORM = '!(osx | ios | android)'
const CUDA_PLATFORM = 'linux'
const GPU_TEST_FILES = [
  'test/integration/gpu.test.js',
  'test/integration/parakeet-gpu-smoke.test.js'
]

function speechDependencies(dependencies) {
  return dependencies.filter((dependency) => dependency.name === SPEECH_PORT)
}

function desktopSpeechDependency() {
  return speechDependencies(vcpkgManifest.dependencies).find(
    (dependency) => dependency.platform === DESKTOP_PLATFORM
  )
}

function cudaFeature() {
  return vcpkgManifest.features[CUDA_MANIFEST_FEATURE]
}

function cudaSpeechDependency() {
  return speechDependencies(cudaFeature().dependencies)[0]
}

function versionFloorOf(dependency) {
  return dependency['version>=']
}

test('the CUDA build is opt-in behind a dedicated CMake option', () => {
  assert.match(cmakeSource, new RegExp(`option\\(${CUDA_CMAKE_OPTION} "[^"]+" OFF\\)`))
  assert.equal(packageJson.scripts['build:native'].includes(CUDA_CMAKE_OPTION), false)
})

test('the CUDA CMake option selects the cuda vcpkg manifest feature', () => {
  assert.match(
    cmakeSource,
    new RegExp(
      `if\\(${CUDA_CMAKE_OPTION}\\)\\s*\\n\\s*list\\(APPEND VCPKG_MANIFEST_FEATURES "${CUDA_MANIFEST_FEATURE}"\\)`
    )
  )
})

test('the CUDA build scripts turn the CMake option on', () => {
  assert.match(packageJson.scripts['build:native:cuda'], /bare-make generate -D ASR_CUDA=ON/)
  assert.equal(packageJson.scripts['build:cuda'], 'npm run build:ts && npm run build:native:cuda')
})

test('the cuda feature forwards to the speech-cpp CUDA backend', () => {
  assert.deepEqual(cudaSpeechDependency().features, [CUDA_MANIFEST_FEATURE])
  assert.equal(cudaSpeechDependency()['default-features'], false)
})

test('the cuda feature is confined to Linux, the one supported CUDA build platform', () => {
  assert.equal(cudaFeature().supports, CUDA_PLATFORM)
  assert.equal(cudaSpeechDependency().platform, CUDA_PLATFORM)
})

test('the cuda feature requires a speech-cpp that declares it', () => {
  assert.ok(versionFloorOf(cudaSpeechDependency()) >= versionFloorOf(desktopSpeechDependency()))
})

test('no direct CUDA linkage - the hybrid MODULE backend carries its own', () => {
  assert.equal(
    /CUDA::/.test(cmakeSource),
    false,
    'linking the CUDA runtime into the .bare would break the graceful CPU/Vulkan fallback on hosts without an NVIDIA driver'
  )
})

test('the whisper backend loader covers desktop Linux for hybrid GGML_BACKEND_DL builds', () => {
  assert.match(
    whisperModelSource,
    /#if defined\(__ANDROID__\) \|\| defined\(__linux__\)/,
    'ensureBackendsLoaded must compile on all Linux targets, not just arm64'
  )
  assert.equal(
    /defined\(__aarch64__\)/.test(whisperModelSource),
    false,
    'no arm64-only gate may remain around the backend loader'
  )
})

test('the GPU integration tests accept CUDA as a desktop backend', () => {
  GPU_TEST_FILES.forEach((file) => {
    const source = fs.readFileSync(path.join(packageRoot, file), 'utf8')
    assert.match(source, /id === 2 \|\| id === 3/, file)
  })
})
