'use strict'

const GPU_DEVICE = 1
const GPU_BACKEND_IDS = { metal: 1, cuda: 2, vulkan: 3, opencl: 4 }
const AUTOMATIC_BACKEND_IDS = [GPU_BACKEND_IDS.cuda, GPU_BACKEND_IDS.vulkan]

function expectedBackendIds(pinnedBackend) {
  if (!pinnedBackend) return AUTOMATIC_BACKEND_IDS
  const name = pinnedBackend.toLowerCase()
  return Object.prototype.hasOwnProperty.call(GPU_BACKEND_IDS, name) ? [GPU_BACKEND_IDS[name]] : []
}

function assertDesktopGpuBackend(t, label, device, backendId, pinnedBackend = '') {
  t.is(device, GPU_DEVICE, `${label}: GPU device required`)
  t.ok(
    expectedBackendIds(pinnedBackend).includes(backendId),
    `${label}: expected ${pinnedBackend || 'CUDA or Vulkan'} backend, got backendId=${backendId}`
  )
}

module.exports = { assertDesktopGpuBackend }
