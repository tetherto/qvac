'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const packageRoot = path.resolve(__dirname, '..', '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const vcpkgManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'vcpkg.json'), 'utf8'))
const cmakeSource = fs.readFileSync(path.join(packageRoot, 'CMakeLists.txt'), 'utf8')
const testCmakeSource = fs.readFileSync(
  path.join(packageRoot, 'addon/tests/CMakeLists.txt'),
  'utf8'
)
const bindingSource = fs.readFileSync(path.join(packageRoot, 'binding.js'), 'utf8')
const projectJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'project.json'), 'utf8'))
const whisperModelSource = fs.readFileSync(
  path.join(packageRoot, 'addon/src/model-interface/whisper/WhisperModel.cpp'),
  'utf8'
)

const FABRIC = '@qvac/fabric'
const FABRIC_PORT = 'qvac-fabric'
const GGML_SPEECH_PORT = 'ggml-speech'
const SPEECH_PORT = 'speech-cpp'
const DESKTOP_HOSTS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'win32-x64']
const MOBILE_HOSTS = ['android-arm64', 'ios']
const BACKEND_FEATURES = ['metal', 'vulkan', 'opencl', 'cuda', 'webgpu']
const RETIRED_BUILD_OPTIONS = ['ASR_CUDA', 'ASR_WEBGPU']
const RETIRED_BUILD_SCRIPTS = ['build:cuda', 'build:native:cuda']
const GPU_TEST_FILES = [
  'test/integration/gpu.test.js',
  'test/integration/parakeet-gpu-smoke.test.js'
]

function dependencyName(dependency) {
  return typeof dependency === 'string' ? dependency : dependency.name
}

function speechDependencies() {
  return vcpkgManifest.dependencies.filter((dependency) => dependency.name === SPEECH_PORT)
}

function backendFeaturesOf(dependency) {
  return dependency.features.filter((feature) => BACKEND_FEATURES.includes(feature))
}

function publishBuildCi() {
  return projectJson.targets.build.options.ci
}

function overridesOf(port) {
  return (vcpkgManifest.overrides ?? []).filter((entry) => entry.name === port)
}

test('the ggml runtime is the shared @qvac/fabric prebuild', () => {
  assert.match(cmakeSource, /qvac_addon_use_fabric\(\)/)
  assert.match(cmakeSource, /qvac_addon_link_fabric\(/)
  assert.match(cmakeSource, /qvac_addon_finalize\(/)
  assert.equal(
    /find_package\(ggml/.test(cmakeSource),
    false,
    'ggml comes from fabric, not from a vcpkg port'
  )
  assert.equal(
    /GGML_AVAILABLE_BACKENDS/.test(cmakeSource),
    false,
    'fabric ships and loads its own backends'
  )
  assert.equal(/qvac-speech-ggml/.test(cmakeSource), false, 'no ggml-speech module pickup remains')
})

test('both engine packages link the fabric headers in place of the ggml archives', () => {
  assert.match(
    cmakeSource,
    /qvac_addon_engine_on_fabric\(whisper::whisper qvac::parakeet qvac::parakeet-backend-defs\)/
  )
  assert.equal(/ggml::/.test(cmakeSource), false, 'no ggml target is linked by hand')
})

test('the C++ tests link and stage the fabric runtime next to the test binary', () => {
  assert.match(cmakeSource, /add_subdirectory\(addon\/tests\)/)
  assert.match(testCmakeSource, /\$\{qvac_fabric_target\}_module/)
  assert.match(testCmakeSource, /qvac_addon_stage_fabric_for_test\(asr_ggml_tests /)
  assert.equal(/ggml::/.test(testCmakeSource), false)
  assert.equal(
    /RUNTIME_OUTPUT_DIRECTORY/.test(testCmakeSource),
    false,
    'the binary must stay in the directory the runtime is staged in'
  )
})

test('binding.js pre-loads @qvac/fabric before the addon resolves its runtime', () => {
  const preload = bindingSource.indexOf("require('@qvac/fabric')")
  const addon = bindingSource.indexOf("require('#host-addon')")
  assert.ok(preload >= 0 && addon > preload)
})

test('package.json declares the fabric runtime and its platform packages at one range', () => {
  const range = packageJson.dependencies[FABRIC]
  assert.ok(range, `${FABRIC} must be a dependency`)
  DESKTOP_HOSTS.forEach((host) =>
    assert.equal(packageJson.optionalDependencies[`${FABRIC}-${host}`], range, host)
  )
  MOBILE_HOSTS.forEach((host) => {
    assert.equal(packageJson.peerDependencies[`${FABRIC}-${host}`], range, host)
    assert.equal(packageJson.peerDependenciesMeta[`${FABRIC}-${host}`].optional, true, host)
    assert.equal(packageJson.devDependencies[`${FABRIC}-${host}`], range, host)
  })
  assert.equal(
    packageJson.qvac,
    undefined,
    'no ggml-speech build is recorded: the runtime is fabric'
  )
})

test('vcpkg.json builds the engines without ggml backend features', () => {
  const names = vcpkgManifest.dependencies.map(dependencyName)
  assert.equal(names.includes(GGML_SPEECH_PORT), false)
  const fabricPort = vcpkgManifest.dependencies.find(
    (dependency) => dependency.name === FABRIC_PORT
  )
  assert.ok(
    fabricPort,
    'qvac-fabric is listed so vcpkg honours default-features false for the engine port'
  )
  assert.equal(fabricPort['default-features'], false)
  assert.equal(
    fabricPort.features,
    undefined,
    'the port is compiled against only; the runtime is the npm package'
  )
  speechDependencies().forEach((dependency) =>
    assert.deepEqual(
      backendFeaturesOf(dependency),
      [],
      `${dependency.platform}: backends come from the fabric runtime`
    )
  )
  BACKEND_FEATURES.forEach((feature) =>
    assert.equal(vcpkgManifest.features[feature], undefined, feature)
  )
  assert.equal(overridesOf(GGML_SPEECH_PORT).length, 0)
  assert.equal(overridesOf(SPEECH_PORT).length, 1)
})

test('every platform builds both engines, and Apple hosts keep the Core ML sidecars', () => {
  speechDependencies().forEach((dependency) => {
    assert.ok(dependency.features.includes('whisper'), dependency.platform)
    assert.ok(dependency.features.includes('parakeet'), dependency.platform)
  })
  const apple = speechDependencies().find((dependency) => dependency.platform === 'osx | ios')
  assert.ok(apple.features.includes('coreml'))
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

test('the published prebuilds need no CUDA toolkit or Vulkan SDK', () => {
  assert.equal(publishBuildCi().includeCuda, undefined)
  assert.equal(publishBuildCi().includeVulkanSdk, undefined)
  assert.equal(publishBuildCi().platformCmakeDefines, undefined)
  RETIRED_BUILD_OPTIONS.forEach((option) =>
    assert.equal(cmakeSource.includes(option), false, option)
  )
  RETIRED_BUILD_SCRIPTS.forEach((script) =>
    assert.equal(packageJson.scripts[script], undefined, script)
  )
})

test('no direct CUDA linkage - the fabric runtime carries its own backend module', () => {
  assert.equal(
    /CUDA::/.test(cmakeSource),
    false,
    'linking the CUDA runtime into the .bare would break the graceful CPU/Vulkan fallback on hosts without an NVIDIA driver'
  )
})

test('the whisper backend loader covers every host that loads backends as modules', () => {
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

test('whisper loads the backends fabric ships unless a directory is configured', () => {
  assert.match(whisperModelSource, /qvac_fabric_load_backends\(\)/)
  assert.match(whisperModelSource, /ggml_backend_load_all_from_path\(backendsDir\.c_str\(\)\)/)
})

test('the GPU integration tests accept CUDA as a desktop backend', () => {
  GPU_TEST_FILES.forEach((file) => {
    const source = fs.readFileSync(path.join(packageRoot, file), 'utf8')
    assert.match(source, /id === 2 \|\| id === 3/, file)
  })
})
