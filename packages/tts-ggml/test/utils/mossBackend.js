'use strict'

const GPU_BACKEND_IDS = { metal: 1, cuda: 2, vulkan: 3, opencl: 4 }

// The native engine reads TTS_CPP_GPU_BACKEND. Check its reported backend as
// well: a different GPU must not make a CUDA/Vulkan validation lane pass.
function assertMossBackend(t, label, stats, useGPU, pinnedBackend = '') {
  if (!stats) {
    t.fail(`${label}: missing runtime stats; cannot verify the backend`)
    return
  }
  t.is(stats.backendDevice, useGPU ? 1 : 0, `${label}: requested compute device`)
  if (!useGPU) {
    t.is(stats.backendId, 0, `${label}: CPU requested explicitly`)
    return
  }
  t.is(stats.gpuUnsupported, 0, `${label}: no GPU fallback`)
  pinnedBackend = pinnedBackend.toLowerCase()
  if (pinnedBackend) {
    if (!Object.prototype.hasOwnProperty.call(GPU_BACKEND_IDS, pinnedBackend)) {
      t.fail(`${label}: unknown TTS_CPP_GPU_BACKEND=${pinnedBackend}`)
      return
    }
    t.is(
      stats.backendId,
      GPU_BACKEND_IDS[pinnedBackend],
      `${label}: TTS_CPP_GPU_BACKEND=${pinnedBackend}`
    )
  } else {
    t.ok(Object.values(GPU_BACKEND_IDS).includes(stats.backendId), `${label}: known GPU backend`)
  }
}

module.exports = { assertMossBackend }
