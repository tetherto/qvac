'use strict'

const test = require('brittle')
const { _requireGpuBackend } = require('../mobile/test.cjs')

test('mobile GPU validation accepts Vulkan', (t) => {
  t.is(_requireGpuBackend({ backendDevice: 1, backendId: 3 }), 'Vulkan')
})

test('mobile GPU validation accepts OpenCL', (t) => {
  t.is(_requireGpuBackend({ backendDevice: 1, backendId: 4 }), 'OpenCL')
})

test('mobile GPU validation rejects CPU fallback', (t) => {
  t.exception(
    () => _requireGpuBackend({ backendDevice: 0, backendId: 3 }),
    /must run on Vulkan or OpenCL/
  )
})

test('mobile GPU validation rejects unsupported GPU backends', (t) => {
  t.exception(
    () => _requireGpuBackend({ backendDevice: 1, backendId: 2 }),
    /must run on Vulkan or OpenCL/
  )
})
