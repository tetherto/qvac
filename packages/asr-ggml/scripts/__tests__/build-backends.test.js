'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const packageRoot = path.resolve(__dirname, '..', '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const vcpkgManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'vcpkg.json'), 'utf8'))
const cmakeSource = fs.readFileSync(path.join(packageRoot, 'CMakeLists.txt'), 'utf8')
const speechCmakeSource = fs.readFileSync(
  path.resolve(packageRoot, '../../cmake/qvac-addon/speech-engines.cmake'),
  'utf8'
)
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
const DESKTOP_HOSTS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'win32-x64']
const MOBILE_HOSTS = ['android-arm64', 'ios']
const RETIRED_BUILD_OPTIONS = ['ASR_CUDA', 'ASR_WEBGPU']
const RETIRED_BUILD_SCRIPTS = ['build:cuda', 'build:native:cuda']
const GPU_TEST_FILES = [
  'test/integration/gpu.test.js',
  'test/integration/parakeet-gpu-smoke.test.js'
]

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
  assert.match(cmakeSource, /qvac_addon_speech_engines\(whisper parakeet\)/)
  assert.equal(/ggml::/.test(cmakeSource), false, 'no ggml target is linked by hand')
})

test('speech source updates refresh extracted timestamps so incremental builds recompile', () => {
  assert.match(
    speechCmakeSource,
    /FetchContent_Declare\(qvac_speech\b[^)]*\bDOWNLOAD_EXTRACT_TIMESTAMP\s+FALSE\b/
  )
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

test('CI restores Fabric before building or linting speech', () => {
  for (const name of ['build', 'cpp:lint', 'cpp:build']) {
    assert.ok(
      projectJson.targets[name].dependsOn.some(
        (dependency) =>
          dependency.target === 'link:platform' && dependency.projects.includes(FABRIC)
      )
    )
  }
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

test('vcpkg cannot acquire an independent speech or ggml runtime', () => {
  const manifest = vcpkgManifest
  const names = manifest.dependencies.map((dependency) =>
    typeof dependency === 'string' ? dependency : dependency.name
  )
  for (const name of ['ggml-speech', 'qvac-fabric', 'speech-cpp']) {
    assert.equal(names.includes(name), false)
  }
})

test('backend build switches belong to Fabric', () => {
  for (const option of RETIRED_BUILD_OPTIONS) assert.equal(cmakeSource.includes(option), false)
  for (const script of RETIRED_BUILD_SCRIPTS) assert.equal(packageJson.scripts[script], undefined)
})
