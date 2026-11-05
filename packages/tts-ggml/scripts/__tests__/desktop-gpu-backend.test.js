'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { assertDesktopGpuBackend } = require('../../test/utils/desktopGpuBackend')

const assertions = { is: assert.equal, ok: assert.ok }
const GPU_DEVICE = 1
const CPU_DEVICE = 0
const BACKENDS = { cpu: 0, metal: 1, cuda: 2, vulkan: 3, opencl: 4, unknown: 99 }

function checkBackend(backendId, pin = '', device = GPU_DEVICE) {
  assertDesktopGpuBackend(assertions, 'desktop GPU', device, backendId, pin)
}

function checkRejectedBackends(ids, pin = '') {
  for (const id of ids) assert.throws(() => checkBackend(id, pin))
}

function registerPinnedBackendTests() {
  for (const pin of ['cuda', 'CUDA', 'CuDa', 'vulkan', 'VULKAN', 'VuLkAn']) {
    test(`a ${pin} pin requires exactly that backend`, () => {
      const expected = BACKENDS[pin.toLowerCase()]
      checkBackend(expected, pin)
      checkRejectedBackends(
        Object.values(BACKENDS).filter((id) => id !== expected),
        pin
      )
      assert.throws(() => checkBackend(expected, pin, CPU_DEVICE))
    })
  }
}

test('automatic selection accepts CUDA and Vulkan', () => {
  checkBackend(BACKENDS.cuda)
  checkBackend(BACKENDS.vulkan)
})

test('automatic selection rejects CPU, unsupported and missing GPU telemetry', () => {
  checkRejectedBackends([
    BACKENDS.cpu,
    BACKENDS.metal,
    BACKENDS.opencl,
    BACKENDS.unknown,
    undefined
  ])
  assert.throws(() => checkBackend(BACKENDS.cuda, '', CPU_DEVICE))
  assert.throws(() => assertDesktopGpuBackend(assertions, 'desktop GPU', undefined, BACKENDS.cuda))
  assert.throws(() => checkBackend(BACKENDS.cuda, '', '1'))
  assert.throws(() => checkBackend('2'))
})

test('an unknown pin cannot fall back to an automatic backend', () => {
  checkRejectedBackends([BACKENDS.cuda, BACKENDS.vulkan, undefined], 'typo')
  checkRejectedBackends([BACKENDS.cuda, BACKENDS.vulkan, undefined], 'toString')
  checkRejectedBackends([BACKENDS.cuda, BACKENDS.vulkan, undefined], '__proto__')
})

test('explicit Metal and OpenCL pins retain their exact backend checks', () => {
  checkBackend(BACKENDS.metal, 'metal')
  checkBackend(BACKENDS.opencl, 'opencl')
  checkRejectedBackends([BACKENDS.cuda, BACKENDS.vulkan], 'metal')
  checkRejectedBackends([BACKENDS.cuda, BACKENDS.vulkan], 'opencl')
})

registerPinnedBackendTests()
