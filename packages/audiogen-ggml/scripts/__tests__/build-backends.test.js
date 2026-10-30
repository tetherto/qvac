'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const packageRoot = path.resolve(__dirname, '..', '..')
const cmakeSource = fs.readFileSync(path.join(packageRoot, 'CMakeLists.txt'), 'utf8')
const bindingSource = fs.readFileSync(path.join(packageRoot, 'binding.js'), 'utf8')
const projectJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'project.json'), 'utf8'))
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const vcpkgJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'vcpkg.json'), 'utf8'))

const FABRIC = '@qvac/fabric'
const SPEECH_PORT = 'speech-cpp'
const ENGINE_FEATURE = 'audiogen'
const BACKEND_FEATURES = ['metal', 'vulkan', 'opencl', 'cuda', 'webgpu']
const DESKTOP_HOSTS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'win32-x64']
const MOBILE_HOSTS = ['android-arm64', 'ios']

function publishBuildCi() {
  return projectJson.targets.build.options.ci
}

function dependencyName(dependency) {
  return typeof dependency === 'string' ? dependency : dependency.name
}

function speechDependencies() {
  return vcpkgJson.dependencies.filter((dependency) => dependency.name === SPEECH_PORT)
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

test('the engine package links the fabric headers in place of the ggml archives', () => {
  assert.match(cmakeSource, /qvac_addon_engine_on_fabric\(audiogen-cpp::audiogen-cpp\)/)
  assert.equal(/add_library\(ggml::/.test(cmakeSource), false, 'no ggml target is declared by hand')
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

test('vcpkg.json builds the engine without ggml backend features', () => {
  const names = vcpkgJson.dependencies.map(dependencyName)
  assert.equal(names.includes('ggml-speech'), false)
  const fabricPort = vcpkgJson.dependencies.find((dependency) => dependency.name === 'qvac-fabric')
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
  speechDependencies().forEach((dependency) => {
    const backends = dependency.features.filter((feature) => BACKEND_FEATURES.includes(feature))
    assert.deepEqual(backends, [], 'backends come from the fabric runtime')
  })
  assert.equal(vcpkgJson.features.cuda, undefined)
  assert.equal(vcpkgJson.features.vulkan, undefined)
  assert.equal(vcpkgJson.overrides.filter((entry) => entry.name === SPEECH_PORT).length, 1)
})

test('one speech-cpp dependency builds the audiogen engine on every platform', () => {
  const speech = speechDependencies()
  assert.equal(speech.length, 1)
  assert.equal(speech[0].platform, undefined)
  assert.deepEqual(speech[0].features, [ENGINE_FEATURE])
})

test('the published prebuilds need no CUDA toolkit or Vulkan SDK', () => {
  assert.equal(publishBuildCi().includeCuda, undefined)
  assert.equal(publishBuildCi().includeVulkanSdk, undefined)
  assert.equal(publishBuildCi().platformCmakeDefines, undefined)
  assert.equal(/ENABLE_CUDA/.test(cmakeSource), false)
  assert.equal(packageJson.scripts['build:cuda'], undefined)
})
