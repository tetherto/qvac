'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const packageRoot = path.resolve(__dirname, '..', '..')
const cmakeSource = fs.readFileSync(path.join(packageRoot, 'CMakeLists.txt'), 'utf8')
const projectJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'project.json'), 'utf8'))

const CUDA_OPTION = 'ENABLE_CUDA'
const PUBLISHED_CUDA_HOST = 'linux-x64'

// The CI contract: each platform's build configuration args, and the hosts nx.json sets CUDA up on.
function buildArgs(host) {
  return projectJson.targets.build.configurations[host]?.args ?? ''
}

function cudaHosts() {
  const nxJson = JSON.parse(fs.readFileSync(path.join(packageRoot, '..', '..', 'nx.json'), 'utf8'))
  const { hostSetup } = nxJson.targetDefaults.build.metadata.toolchain
  return Object.keys(hostSetup).filter((h) => hostSetup[h].includes('cuda'))
}

test('the CUDA build stays an opt-in CMake option', () => {
  assert.match(cmakeSource, new RegExp(`option\\(${CUDA_OPTION} "[^"]+" OFF\\)`))
})

test('the published linux-x64 prebuild builds the CUDA backend', () => {
  assert.ok(cudaHosts().includes(PUBLISHED_CUDA_HOST))
  assert.match(buildArgs(PUBLISHED_CUDA_HOST), new RegExp(`-D ${CUDA_OPTION}=ON`))
})
