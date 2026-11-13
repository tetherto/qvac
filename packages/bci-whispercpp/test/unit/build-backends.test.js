'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const test = require('brittle')

const packageRoot = path.join(__dirname, '..', '..')

function readPackageFile(relativePath) {
  return fs.readFileSync(path.join(packageRoot, relativePath), 'utf8')
}

const packageJson = JSON.parse(readPackageFile('package.json'))
const projectJson = JSON.parse(readPackageFile('project.json'))
const vcpkgManifest = JSON.parse(readPackageFile('vcpkg.json'))
const cmakeSource = readPackageFile('CMakeLists.txt')
const testsCmakeSource = readPackageFile('addon/tests/CMakeLists.txt')
const bindingSource = readPackageFile('binding.js')
const nativeBindingSource = readPackageFile('addon/src/js-interface/binding.cpp')
const bciModelSource = readPackageFile('addon/src/model-interface/bci/BCIModel.cpp')
const gpuSmokeSource = readPackageFile('test/integration/gpu-smoke.test.js')

const FABRIC = '@qvac/fabric'
const FABRIC_PORT = 'qvac-fabric'
const GGML_SPEECH_PORT = 'ggml-speech'
const SPEECH_PORT = 'speech-cpp'
const ENGINE_FEATURE = 'whisper'
const BACKEND_FEATURES = ['metal', 'vulkan', 'opencl', 'cuda', 'webgpu']
const DESKTOP_HOSTS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'win32-x64']
const MOBILE_HOSTS = ['android-arm64', 'ios']
const CUDA_CMAKE_OPTION = 'ENABLE_CUDA'
const CUDA_SCRIPTS = ['build:cuda', 'build:native:cuda']

function publishBuildCi() {
  return projectJson.targets.build.options.ci
}

function dependenciesNamed(port) {
  return vcpkgManifest.dependencies.filter((dependency) => dependency.name === port)
}

function statementsOf(source) {
  return source.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('//'))
}

test('[build] the ggml runtime is the shared @qvac/fabric prebuild', (t) => {
  t.ok(/qvac_addon_use_fabric\(\)/.test(cmakeSource))
  t.ok(/qvac_addon_link_fabric\(/.test(cmakeSource))
  t.ok(/qvac_addon_finalize\(/.test(cmakeSource))
  t.is(
    /find_package\(ggml/.test(cmakeSource),
    false,
    'ggml comes from fabric, not from a vcpkg port'
  )
  t.is(
    /GGML_AVAILABLE_BACKENDS/.test(cmakeSource),
    false,
    'fabric ships and loads its own backends'
  )
  t.is(/qvac-speech-ggml/.test(cmakeSource), false, 'no ggml-speech module pickup remains')
})

test('[build] the whisper engine links the fabric headers in place of the ggml archives', (t) => {
  t.ok(/qvac_addon_engine_on_fabric\(whisper::whisper\)/.test(cmakeSource))
  t.is(/add_library\(ggml::/.test(cmakeSource), false, 'no ggml target is declared by hand')
})

test('[build] binding.js pre-loads @qvac/fabric, then resolves the addon, with literal specifiers only', (t) => {
  t.alike(statementsOf(bindingSource), [`require('${FABRIC}')`, 'module.exports = require.addon()'])
})

test('[build] the native module binds its fabric imports before exporting', (t) => {
  t.ok(/#include <qvac-addon\/fabric-bind\.h>/.test(nativeBindingSource))
  t.ok(/qvacAddonBindFabric\(\)/.test(nativeBindingSource))
})

test('[build] package.json declares the fabric runtime and its platform packages at one range', (t) => {
  const range = packageJson.dependencies[FABRIC]
  t.ok(range, `${FABRIC} must be a dependency`)
  DESKTOP_HOSTS.forEach((host) =>
    t.is(packageJson.optionalDependencies[`${FABRIC}-${host}`], range, host)
  )
  MOBILE_HOSTS.forEach((host) => {
    t.is(packageJson.peerDependencies[`${FABRIC}-${host}`], range, host)
    t.is(packageJson.peerDependenciesMeta[`${FABRIC}-${host}`].optional, true, host)
    t.is(packageJson.devDependencies[`${FABRIC}-${host}`], range, host)
  })
  t.is(packageJson.qvac, undefined, 'no ggml-speech build is recorded: the runtime is fabric')
})

test('[build] vcpkg.json builds the whisper engine without ggml backend features', (t) => {
  t.is(dependenciesNamed(GGML_SPEECH_PORT).length, 0)
  const [fabricPort] = dependenciesNamed(FABRIC_PORT)
  t.ok(
    fabricPort,
    'qvac-fabric is listed so vcpkg honours default-features false for the engine port'
  )
  t.is(fabricPort['default-features'], false)
  t.is(
    fabricPort.features,
    undefined,
    'the port is compiled against only; the runtime is the npm package'
  )
  const speech = dependenciesNamed(SPEECH_PORT)
  t.is(speech.length, 1, 'one engine build for every platform')
  t.is(speech[0]['default-features'], false)
  t.is(speech[0].platform, undefined)
  t.alike(speech[0].features, [ENGINE_FEATURE])
  t.alike(
    speech[0].features.filter((feature) => BACKEND_FEATURES.includes(feature)),
    [],
    'backends come from the fabric runtime'
  )
  t.is(vcpkgManifest.overrides.filter((entry) => entry.name === SPEECH_PORT).length, 1)
  t.is(vcpkgManifest.overrides.filter((entry) => entry.name === GGML_SPEECH_PORT).length, 0)
})

test('[build] CUDA comes with the runtime: no CUDA option, feature, script or toolkit remains', (t) => {
  t.is(new RegExp(CUDA_CMAKE_OPTION).test(cmakeSource), false)
  t.is(/CUDA::/.test(cmakeSource), false)
  t.is(vcpkgManifest.features.cuda, undefined)
  CUDA_SCRIPTS.forEach((script) => t.is(packageJson.scripts[script], undefined, script))
  t.is(publishBuildCi().includeCuda, undefined)
  t.is(publishBuildCi().platformCmakeDefines, undefined)
})

test('[build] the published prebuilds need no Vulkan SDK', (t) => {
  t.is(publishBuildCi().includeVulkanSdk, undefined)
  t.is(vcpkgManifest.features.vulkan, undefined)
})

test('[build] backends are loaded on every platform, through fabric unless a directory is configured', (t) => {
  t.ok(/qvac_fabric_load_backends\(\)/.test(bciModelSource))
  t.ok(/ggml_backend_load_all_from_path\(/.test(bciModelSource))
  t.is(
    /#if defined\(__ANDROID__\) \|\| defined\(__linux__\)/.test(bciModelSource),
    false,
    'the fabric runtime loads its backends as modules on Windows too'
  )
  t.is(
    /ggml_backend_load_all\(\)/.test(bciModelSource),
    false,
    'no default-search-path fallback remains'
  )
})

test('[build] the C++ tests link and stage the shared fabric runtime', (t) => {
  t.ok(/add_subdirectory\(addon\/tests\)/.test(cmakeSource))
  t.ok(
    /qvac_addon_stage_fabric_for_test\(test-bci-core \$\{qvac_fabric_target\}\)/.test(
      testsCmakeSource
    )
  )
  t.is(
    /ggml::/.test(testsCmakeSource),
    false,
    'the tests take ggml from the runtime, not from static archives'
  )
})

test('[build] the GPU smoke test accepts CUDA as a desktop backend', (t) => {
  t.ok(/id === 2 \|\| id === 3/.test(gpuSmokeSource))
})
