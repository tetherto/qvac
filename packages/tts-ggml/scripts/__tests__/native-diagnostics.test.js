'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

function loadDiagnostics() {
  const context = {
    module: { exports: {} },
    require: (name) => {
      if (name === 'bare-fs') return fs
      if (name === 'bare-os') return { getEnv: () => undefined }
      throw new Error(`Unexpected module: ${name}`)
    },
    console
  }
  const source = path.join(__dirname, '../../test/utils/nativeDiagnostics.js')
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), context)
  return context.module.exports
}

const { denoiserDeclinesGpu, readNativeDiagnostics } = loadDiagnostics()

test('the denoiser declines a selected Android Mali or Immortalis GPU', () => {
  for (const description of ['Mali-G715', 'Immortalis-G720']) {
    const line = `[native-backend] selected=Vulkan0 description=${description}`
    assert.equal(denoiserDeclinesGpu('android', line), true)
  }
})

test('supported or unidentified GPU devices retain strict backend assertions', () => {
  for (const line of [
    '',
    '[native-backend] selected=Vulkan0 description=Adreno 830',
    '[native-backend] selected=OpenCL description=Adreno 840',
    'found an unused Mali-G715 device',
    '[native-backend] selected=CPU description=Mali-G715'
  ]) {
    assert.equal(denoiserDeclinesGpu('android', line), false)
  }
})

test('other platforms retain their existing assertions', () => {
  const line = '[native-backend] selected=Vulkan0 description=Mali-G715'
  assert.equal(denoiserDeclinesGpu('darwin', line), false)
})

test('an unset diagnostics path produces no log output', () => {
  assert.equal(readNativeDiagnostics(), '')
})
