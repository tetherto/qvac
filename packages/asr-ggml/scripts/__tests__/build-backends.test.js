'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const packageRoot = path.resolve(__dirname, '..', '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const vcpkgManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'vcpkg.json'), 'utf8'))
const cmakeSource = fs.readFileSync(path.join(packageRoot, 'CMakeLists.txt'), 'utf8')
const projectJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'project.json'), 'utf8'))
const whisperModelSource = fs.readFileSync(
  path.join(packageRoot, 'addon/src/model-interface/whisper/WhisperModel.cpp'),
  'utf8'
)

const CUDA_CMAKE_OPTION = 'ASR_CUDA'
const PUBLISHED_CUDA_HOST = 'linux-x64'
const CUDA_MANIFEST_FEATURE = 'cuda'
const SPEECH_PORT = 'speech-cpp'
const DESKTOP_PLATFORM = '!(osx | ios | android)'
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

function publishBuildCi() {
  return projectJson.targets.build.options.ci
}

function platformDefines(host) {
  const entry = (publishBuildCi().platformCmakeDefines ?? '')
    .split('\n')
    .find((line) => line.trim().startsWith(`${host}:`))
  return entry === undefined ? '' : entry.slice(entry.indexOf(':') + 1).trim()
}

function versionFloorOf(dependency) {
  return dependency['version>=']
}

function overridesOf(port) {
  return (vcpkgManifest.overrides ?? []).filter((entry) => entry.name === port)
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

test('the cuda feature is confined to the platforms that have NVIDIA GPUs', () => {
  assert.equal(cudaFeature().supports, DESKTOP_PLATFORM)
  assert.equal(cudaSpeechDependency().platform, DESKTOP_PLATFORM)
})

test('the cuda feature takes the speech-cpp that the overrides pin', () => {
  assert.equal(overridesOf(SPEECH_PORT).length, 1)
  assert.equal(versionFloorOf(cudaSpeechDependency()), undefined)
  assert.equal(versionFloorOf(desktopSpeechDependency()), undefined)
})

test('the speech override includes the explicit MOSS backend API', () => {
  const [speech] = overridesOf(SPEECH_PORT)
  assert.ok(speech, 'MOSS load/fit require an explicitly pinned speech port')
  const version = speech.version
  assert.ok(
    version > '2026-10-12' || (version === '2026-10-12' && (speech['port-version'] ?? 0) >= 1),
    'speech-cpp before 2026-10-12#1 lacks TranscribeOptions.backend'
  )
})

test('no direct CUDA linkage - the hybrid MODULE backend carries its own', () => {
  assert.equal(
    /CUDA::/.test(cmakeSource),
    false,
    'linking the CUDA runtime into the .bare would break the graceful CPU/Vulkan fallback on hosts without an NVIDIA driver'
  )
})

test('the whisper backend loader covers every hybrid GGML_BACKEND_DL platform', () => {
  assert.match(
    whisperModelSource,
    /#if defined\(__ANDROID__\) \|\| defined\(__linux__\) \|\| defined\(_WIN32\)/,
    'ensureBackendsLoaded must compile on Android, all Linux targets, and Windows'
  )
  assert.equal(
    /defined\(__aarch64__\)/.test(whisperModelSource),
    false,
    'no arm64-only gate may remain around the backend loader'
  )
})

test('the CMake loose pickup stages Windows .dll modules on CUDA builds', () => {
  assert.match(
    cmakeSource,
    /\(WIN32 AND ASR_CUDA\)/,
    'a win32 ASR_CUDA build must enter the loose module pickup'
  )
  assert.match(
    cmakeSource,
    /qvac-speech-ggml-\*\.dll/,
    'the loose pickup glob must match the Windows backend module names'
  )
})

test('the GPU integration tests accept CUDA as a desktop backend', () => {
  GPU_TEST_FILES.forEach((file) => {
    const source = fs.readFileSync(path.join(packageRoot, file), 'utf8')
    assert.match(source, /id === 2 \|\| id === 3/, file)
  })
})

test('the published linux-x64 prebuild builds the CUDA backend', () => {
  assert.equal(publishBuildCi().includeCuda, true)
  assert.match(platformDefines(PUBLISHED_CUDA_HOST), new RegExp(`-D ${CUDA_CMAKE_OPTION}=ON`))
})
