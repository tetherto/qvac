'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const packageRoot = path.resolve(__dirname, '..', '..')
const cmakeSource = fs.readFileSync(path.join(packageRoot, 'CMakeLists.txt'), 'utf8')
const vcpkgManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'vcpkg.json'), 'utf8'))
const projectJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'project.json'), 'utf8'))

const CUDA_OPTION = 'ENABLE_CUDA'
const PUBLISHED_CUDA_HOST = 'linux-x64'
const CUDA_FEATURE = 'cuda'
const GGML_PORT = 'ggml-speech'
const SPEECH_PORT = 'speech-cpp'
const DESKTOP_PLATFORM = '!(osx | ios | android)'

function namedDependencies(dependencies, name) {
  return dependencies.filter((dependency) => dependency.name === name)
}

// The CI contract: each platform's build configuration args, and the hosts nx.json sets CUDA up on.
function buildArgs(host) {
  return projectJson.targets.build.configurations[host]?.args ?? ''
}

function cudaHosts() {
  const nxJson = JSON.parse(fs.readFileSync(path.join(packageRoot, '..', '..', 'nx.json'), 'utf8'))
  const { hostSetup } = nxJson.targetDefaults.build.metadata.toolchain
  return Object.keys(hostSetup).filter((h) => hostSetup[h].includes('cuda'))
}

function cudaSpeechDependency() {
  return namedDependencies(vcpkgManifest.features[CUDA_FEATURE].dependencies, SPEECH_PORT)[0]
}

function overridesOf(port) {
  return namedDependencies(vcpkgManifest.overrides ?? [], port)
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

test('the hybrid backend dependencies take the versions the overrides pin', () => {
  const ggmlDependency = namedDependencies(vcpkgManifest.dependencies, GGML_PORT)[0]
  const pinnedDependencies = [
    ggmlDependency,
    ...namedDependencies(vcpkgManifest.dependencies, SPEECH_PORT),
    cudaSpeechDependency()
  ]

  assert.equal(ggmlDependency['default-features'], false)
  assert.equal(overridesOf(GGML_PORT).length, 1)
  assert.equal(overridesOf(SPEECH_PORT).length, 1)
  assert.equal(
    pinnedDependencies.every((dependency) => dependency['version>='] === undefined),
    true
  )
})

test('the Windows CUDA build stages runtime-loaded backend modules', () => {
  assert.match(cmakeSource, /\(WIN32 AND ENABLE_CUDA\)/)
  assert.match(cmakeSource, /qvac-speech-ggml-\*\.dll/)
  assert.equal(/CUDA::/.test(cmakeSource), false)
})

test('the published linux-x64 prebuild builds the CUDA backend', () => {
  assert.ok(cudaHosts().includes(PUBLISHED_CUDA_HOST))
  assert.match(buildArgs(PUBLISHED_CUDA_HOST), new RegExp(`-D ${CUDA_OPTION}=ON`))
})
