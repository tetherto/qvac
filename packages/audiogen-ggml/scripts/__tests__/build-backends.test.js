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
const DESKTOP_HOSTS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'win32-x64']
const MOBILE_HOSTS = ['android-arm64', 'ios']

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
  assert.match(cmakeSource, /qvac_addon_speech_engines\(audiogen\)/)
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

test('WebGPU waits for the fabric runtime and no Hexagon build is wired', () => {
  assert.equal(/AUDIOGEN_WEBGPU/.test(cmakeSource), false)
  assert.equal(vcpkgJson.features.webgpu, undefined)
  assert.equal(
    (vcpkgJson.overrides ?? []).some((entry) => entry.name === 'dawn'),
    false
  )
  assert.equal(/HEXAGON|hexagon/.test(cmakeSource), false)
  assert.equal(vcpkgJson.features.hexagon, undefined)
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

test('vcpkg cannot acquire an independent speech or ggml runtime', () => {
  const manifest = vcpkgJson
  const names = manifest.dependencies.map((dependency) =>
    typeof dependency === 'string' ? dependency : dependency.name
  )
  for (const name of ['ggml-speech', 'qvac-fabric', 'speech-cpp']) {
    assert.equal(names.includes(name), false)
  }
})
