'use strict'

// Build-wiring assertions for the opt-in CUDA backend (mirrors
// asr-ggml's scripts/__tests__/build-backends.test.js, adapted to the
// hybrid GGML_BACKEND_DL packaging this addon shares with tts-ggml).

const fs = require('bare-fs')
const path = require('bare-path')
const test = require('brittle')

const packageRoot = path.join(__dirname, '..', '..')

function readPackageFile(relativePath) {
  return fs.readFileSync(path.join(packageRoot, relativePath), 'utf8')
}

const packageJson = JSON.parse(readPackageFile('package.json'))
const vcpkgManifest = JSON.parse(readPackageFile('vcpkg.json'))
const cmakeSource = readPackageFile('CMakeLists.txt')
const bciModelSource = readPackageFile('addon/src/model-interface/bci/BCIModel.cpp')
const gpuSmokeSource = readPackageFile('test/integration/gpu-smoke.test.js')

const CUDA_CMAKE_OPTION = 'ENABLE_CUDA'
const CUDA_MANIFEST_FEATURE = 'cuda'
const SPEECH_PORT = 'speech-cpp'
const DESKTOP_PLATFORM = '!(osx | ios | android)'
const CUDA_PLATFORM = 'linux'

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

test('[build] the CUDA build is opt-in behind a dedicated CMake option', (t) => {
  t.ok(
    new RegExp(`option\\(${CUDA_CMAKE_OPTION} "[^"]+" OFF\\)`).test(cmakeSource),
    `${CUDA_CMAKE_OPTION} is declared OFF by default`
  )
  t.is(
    packageJson.scripts['build:native'].includes(CUDA_CMAKE_OPTION),
    false,
    'the default native build does not enable CUDA'
  )
})

test('[build] the CUDA CMake option selects the cuda vcpkg manifest feature', (t) => {
  t.ok(
    new RegExp(
      `if\\(${CUDA_CMAKE_OPTION}\\)\\s*\\n\\s*list\\(APPEND VCPKG_MANIFEST_FEATURES "${CUDA_MANIFEST_FEATURE}"\\)`
    ).test(cmakeSource),
    'ENABLE_CUDA appends the cuda manifest feature'
  )
})

test('[build] the CUDA build scripts turn the CMake option on', (t) => {
  t.ok(
    /bare-make generate -D ENABLE_CUDA=ON/.test(packageJson.scripts['build:native:cuda']),
    'build:native:cuda generates with ENABLE_CUDA=ON'
  )
  t.is(
    packageJson.scripts['build:cuda'],
    'npm run build:ts && npm run build:native:cuda',
    'build:cuda chains the TypeScript build and the CUDA native build'
  )
})

test('[build] the cuda feature forwards to the speech-cpp CUDA backend', (t) => {
  t.alike(cudaSpeechDependency().features, [CUDA_MANIFEST_FEATURE])
  t.is(cudaSpeechDependency()['default-features'], false)
})

test('[build] the cuda feature is confined to Linux, the one supported CUDA build platform', (t) => {
  t.is(cudaFeature().supports, CUDA_PLATFORM)
  t.is(cudaSpeechDependency().platform, CUDA_PLATFORM)
})

test('[build] the cuda feature requires a speech-cpp that declares it', (t) => {
  t.ok(versionFloorOf(cudaSpeechDependency()) >= versionFloorOf(desktopSpeechDependency()))
})

test('[build] no direct CUDA linkage - the hybrid MODULE backend carries its own', (t) => {
  t.is(
    /CUDA::/.test(cmakeSource),
    false,
    'linking the CUDA runtime into the .bare would break the graceful CPU/Vulkan fallback on hosts without an NVIDIA driver'
  )
})

test('[build] the backend loader covers desktop Linux for hybrid GGML_BACKEND_DL builds', (t) => {
  t.ok(
    /#if defined\(__ANDROID__\) \|\| defined\(__linux__\)/.test(bciModelSource),
    'ensureBackendsLoaded compiles on all Linux targets, not just arm64'
  )
  t.is(
    /defined\(__aarch64__\)/.test(bciModelSource),
    false,
    'no arm64-only gate may remain around the backend loader'
  )
})

test('[build] the GPU smoke test accepts CUDA as a desktop backend', (t) => {
  t.ok(/id === 2 \|\| id === 3/.test(gpuSmokeSource))
})
