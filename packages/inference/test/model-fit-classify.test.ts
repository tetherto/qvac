import test from 'brittle'

import { classifyFit } from '@/model-fit/classify'
import type { FitProbeResult } from '@/model-fit/run/engine'

const PROVENANCE = { basis: 'native-probe', estimatorVersion: 'native-probe-v1' } as const

function device(name: string, usedBytes: number) {
  return {
    id: name,
    name,
    unified: name === 'CPU',
    usedBytes,
    totalBytes: 24 * 1024 ** 3,
    freeBytes: 20 * 1024 ** 3
  }
}

function legacyLlamaDevice(name: string, modelBytes: number) {
  return {
    name,
    totalBytes: 24 * 1024 ** 3,
    freeBytes: 20 * 1024 ** 3,
    modelBytes,
    contextBytes: 0,
    computeBytes: 0
  }
}

function legacyEmbed(devices: ReturnType<typeof legacyLlamaDevice>[]) {
  return {
    engine: 'embed-llamacpp' as const,
    result: {
      status: 'fits' as const,
      reason: 'fits' as const,
      gpuLayers: 32,
      ctxSize: 4096,
      devices,
      deviceBytes: devices
        .filter((row) => row.name !== 'host')
        .reduce((total, row) => total + row.modelBytes + row.contextBytes + row.computeBytes, 0),
      hostBytes: devices
        .filter((row) => row.name === 'host')
        .reduce((total, row) => total + row.modelBytes + row.contextBytes + row.computeBytes, 0),
      trainCtxSize: 8192,
      expertCount: 0
    }
  }
}

type LlamaProbeResult = Extract<FitProbeResult, { engine: 'llm-llamacpp' }>['result']

function llama(
  devices: ReturnType<typeof device>[],
  status: LlamaProbeResult['status'] = 'fits',
  gpuLayers = 32
): FitProbeResult {
  return {
    engine: 'llm-llamacpp',
    result: {
      status,
      devices,
      stats: { gpuLayers, ctxSize: 4096 }
    }
  }
}

function sharedTts(devices: ReturnType<typeof device>[]) {
  return { engine: 'tts-ggml' as const, result: { status: 'fits' as const, devices, stats: {} } }
}

function sharedAudiogen(devices: ReturnType<typeof device>[]) {
  return {
    engine: 'audiogen-ggml' as const,
    result: { status: 'fits' as const, devices, stats: {} }
  }
}

function legacyTts() {
  return {
    engine: 'tts-ggml' as const,
    result: {
      status: 'fits' as const,
      reason: 'fits',
      deviceName: 'Metal',
      deviceBytes: 2 * 1024 ** 3,
      hostBytes: 128 * 1024 ** 2,
      deviceFreeBytes: 20 * 1024 ** 3,
      deviceTotalBytes: 24 * 1024 ** 3,
      report: 'table',
      weightsBytes: 1024 ** 3,
      stateBytes: 64 * 1024 ** 2,
      lmComputeBytes: 32 * 1024 ** 2,
      codecComputeBytes: 16 * 1024 ** 2
    }
  }
}

function legacyBci() {
  return {
    engine: 'bci-whispercpp' as const,
    result: {
      status: 'fits' as const,
      reason: 'fits',
      deviceName: 'Metal',
      deviceBytes: 2 * 1024 ** 3,
      hostBytes: 128 * 1024 ** 2,
      deviceFreeBytes: 20 * 1024 ** 3,
      deviceTotalBytes: 24 * 1024 ** 3,
      report: 'table',
      weightsBytes: 1024 ** 3,
      kvBytes: 64 * 1024 ** 2,
      computeBytes: 32 * 1024 ** 2
    }
  }
}

function legacyAudiogen() {
  return {
    engine: 'audiogen-ggml' as const,
    result: {
      status: 'fits' as const,
      reason: 'fits',
      deviceName: 'Metal',
      deviceBytes: 3 * 1024 ** 3,
      hostBytes: 128 * 1024 ** 2,
      deviceFreeBytes: 20 * 1024 ** 3,
      deviceTotalBytes: 24 * 1024 ** 3,
      report: 'table'
    }
  }
}

test('a shared fit result keeps GPU and CPU demand separate', (t) => {
  const outcome = classifyFit(
    llama([device('Metal', 4 * 1024 ** 3), device('CPU', 1024 ** 3)]),
    PROVENANCE
  )

  t.is(outcome.plan?.nGpuDevices, 1)
  t.is(outcome.projection?.deviceName, 'Metal')
  t.is(outcome.projection?.deviceBytes, 4 * 1024 ** 3)
  t.is(outcome.projection?.hostBytes, 1024 ** 3)
})

test('a device holding no weights is not counted', (t) => {
  const outcome = classifyFit(
    llama([device('CUDA0', 5 * 1024 ** 3), device('CUDA1', 0), device('CPU', 0)]),
    PROVENANCE
  )

  t.is(outcome.plan?.nGpuDevices, 1)
})

test('a shared llama result with no GPU layers spans no GPU', (t) => {
  const outcome = classifyFit(llama([device('CUDA0', 256 * 1024 ** 2)], 'fits', 0), PROVENANCE)

  t.is(outcome.plan?.nGpuLayers, 0)
  t.is(outcome.plan?.nGpuDevices, 0)
})

// The fitter assigns to the CPU backend device like any other, but its demand
// is host memory, so it is not a device the offload spans.
test('the CPU backend device is not a GPU the offload spans', (t) => {
  const outcome = classifyFit(
    llama([device('Metal', 4 * 1024 ** 3), device('CPU', 1024 ** 3)]),
    PROVENANCE
  )

  t.is(outcome.plan?.nGpuDevices, 1)
  t.is(outcome.projection?.deviceName, 'Metal')
})

test('a wholly CPU-resident load spans no GPU', (t) => {
  const outcome = classifyFit(llama([device('CPU', 5 * 1024 ** 3)]), PROVENANCE)

  t.is(outcome.plan?.nGpuDevices, 0)
  t.is(outcome.projection?.deviceName, 'CPU')
  t.absent(outcome.projection?.deviceBytes)
  t.is(outcome.projection?.hostBytes, 5 * 1024 ** 3)
})

test('a placement is reported only where the load fits', (t) => {
  const outcome = classifyFit(llama([device('Metal', 4 * 1024 ** 3)], 'does-not-fit'), PROVENANCE)

  t.is(outcome.verdict, 'does-not-fit')
  t.absent(outcome.plan)
  // The figures matter most where the load does not fit.
  t.is(outcome.projection?.deviceBytes, 4 * 1024 ** 3)
})

test('an unknown shared fit result carries no figures', (t) => {
  const outcome = classifyFit(llama([], 'unknown'), PROVENANCE)

  t.is(outcome.verdict, 'unknown')
  t.is(outcome.reason, 'unknown')
  t.absent(outcome.projection)
  t.absent(outcome.plan)
})

test('the diffusion placement stands in for a reason string', (t) => {
  const base = {
    reason: 'does-not-fit' as const,
    vaeTiling: false,
    streamLayers: false,
    backend: 'Metal',
    paramsBackend: '',
    report: 'per-module table'
  }

  const moved = classifyFit(
    { engine: 'diffusion-cpp', result: { ...base, status: 'does-not-fit', changed: true } },
    PROVENANCE
  )
  t.is(moved.reason, 'does-not-fit-as-configured (Metal)')

  const refused = classifyFit(
    { engine: 'diffusion-cpp', result: { ...base, status: 'does-not-fit', changed: false } },
    PROVENANCE
  )
  t.is(refused.reason, 'does-not-fit')

  const unreadable = classifyFit(
    {
      engine: 'diffusion-cpp',
      result: { ...base, status: 'error', reason: 'model-unreadable' as const, changed: false }
    },
    PROVENANCE
  )
  t.is(unreadable.verdict, 'unknown')
  t.is(unreadable.reason, 'model-unreadable')

  const unsupported = classifyFit(
    {
      engine: 'diffusion-cpp',
      result: { ...base, status: 'error', reason: 'unsupported-config' as const, changed: false }
    },
    PROVENANCE
  )
  t.is(unsupported.verdict, 'unknown')
  t.is(unsupported.reason, 'unsupported-config')
})

test('a speech projection carries the device the engine measured', (t) => {
  const outcome = classifyFit(
    sharedTts([device('Metal', 2 * 1024 ** 3), device('CPU', 128 * 1024 ** 2)]),
    PROVENANCE
  )

  t.is(outcome.engine, 'tts-ggml')
  t.is(outcome.verdict, 'fit')
  // Nothing about a voice load is layer-sliced across devices.
  t.absent(outcome.plan)
  t.alike(outcome.projection, {
    deviceName: 'Metal',
    deviceBytes: 2 * 1024 ** 3,
    hostBytes: 128 * 1024 ** 2,
    deviceFreeBytes: 20 * 1024 ** 3,
    deviceTotalBytes: 24 * 1024 ** 3
  })
})

test('published tts fit results keep their memory breakdown', (t) => {
  const outcome = classifyFit(legacyTts(), PROVENANCE)

  t.is(outcome.projection?.weightsBytes, 1024 ** 3)
  t.is(outcome.projection?.contextBytes, 64 * 1024 ** 2)
  t.is(outcome.projection?.computeBytes, 48 * 1024 ** 2)
})

test('published bci fit results keep their memory breakdown', (t) => {
  const outcome = classifyFit(legacyBci(), PROVENANCE)

  t.is(outcome.projection?.weightsBytes, 1024 ** 3)
  t.is(outcome.projection?.contextBytes, 64 * 1024 ** 2)
  t.is(outcome.projection?.computeBytes, 32 * 1024 ** 2)
})

test('published audiogen fit results keep their totals', (t) => {
  const outcome = classifyFit(legacyAudiogen(), PROVENANCE)

  t.is(outcome.verdict, 'fit')
  t.is(outcome.projection?.deviceBytes, 3 * 1024 ** 3)
  t.is(outcome.projection?.hostBytes, 128 * 1024 ** 2)
  t.absent(outcome.projection?.weightsBytes)
  t.absent(outcome.projection?.contextBytes)
  t.absent(outcome.projection?.computeBytes)
})

test('a shared engine result reporting only totals has no breakdown', (t) => {
  const outcome = classifyFit(sharedAudiogen([device('Metal', 3 * 1024 ** 3)]), PROVENANCE)

  t.absent(outcome.projection?.weightsBytes)
  t.absent(outcome.projection?.contextBytes)
  t.absent(outcome.projection?.computeBytes)
  t.is(outcome.projection?.deviceBytes, 3 * 1024 ** 3)
})

test('the embed breakdown sums every device the demand is charged to', (t) => {
  const rows = [
    {
      ...legacyLlamaDevice('CUDA0', 3 * 1024 ** 3),
      contextBytes: 1024 ** 3,
      computeBytes: 256 * 1024 ** 2
    },
    {
      ...legacyLlamaDevice('CUDA1', 2 * 1024 ** 3),
      contextBytes: 512 * 1024 ** 2
    },
    {
      ...legacyLlamaDevice('host', 1024 ** 3),
      contextBytes: 1024 ** 3,
      computeBytes: 1024 ** 3
    }
  ]

  const outcome = classifyFit(legacyEmbed(rows), PROVENANCE)

  t.is(outcome.projection?.weightsBytes, 5 * 1024 ** 3)
  t.is(outcome.projection?.contextBytes, 1536 * 1024 ** 2)
  t.is(outcome.projection?.computeBytes, 256 * 1024 ** 2)
})

test('the embed projection keeps a row per device, host excluded', (t) => {
  const rows = [
    {
      ...legacyLlamaDevice('CPU', 1024 ** 3),
      contextBytes: 256 * 1024 ** 2
    },
    {
      ...legacyLlamaDevice('CUDA0', 3 * 1024 ** 3),
      contextBytes: 1024 ** 3,
      computeBytes: 256 * 1024 ** 2
    },
    {
      ...legacyLlamaDevice('CUDA1', 2 * 1024 ** 3),
      contextBytes: 512 * 1024 ** 2
    },
    {
      ...legacyLlamaDevice('host', 1024 ** 3),
      contextBytes: 1024 ** 3,
      computeBytes: 1024 ** 3
    }
  ]

  const outcome = classifyFit(legacyEmbed(rows), PROVENANCE)
  const devices = outcome.projection?.devices

  t.is(devices?.length, 3, 'the host row is carried by hostBytes instead')
  t.alike(
    devices?.map((row) => row.name),
    ['CPU', 'CUDA0', 'CUDA1']
  )
  t.is(outcome.projection?.deviceName, 'CUDA0', 'deviceName names the first non-CPU row')
  t.is(devices?.[1]?.weightsBytes, 3 * 1024 ** 3)
  t.is(devices?.[1]?.contextBytes, 1024 ** 3)
  t.is(devices?.[2]?.weightsBytes, 2 * 1024 ** 3)

  const summed = devices?.reduce((total, row) => total + row.weightsBytes, 0)
  t.is(summed, outcome.projection?.weightsBytes, 'the flattened total sums the rows')
})

test('an engine other than legacy llama carries no device rows', (t) => {
  const outcome = classifyFit(legacyTts(), PROVENANCE)

  t.absent(outcome.projection?.devices)
})

test('a translation projection charges its whole allowance to the device it ran on', (t) => {
  const outcome = classifyFit(
    {
      engine: 'translation-nmtcpp',
      result: {
        status: 'fits',
        reason: 'fits',
        backend: 'CPU',
        modelBytes: 40 * 1024 ** 2,
        requiredBytes: 672 * 1024 ** 2,
        freeBytes: 8 * 1024 ** 3,
        report: 'estimate'
      }
    },
    PROVENANCE
  )

  t.is(outcome.engine, 'translation-nmtcpp')
  t.is(outcome.verdict, 'fit')
  t.alike(outcome.projection, {
    deviceName: 'CPU',
    deviceBytes: 672 * 1024 ** 2,
    deviceFreeBytes: 8 * 1024 ** 3,
    weightsBytes: 40 * 1024 ** 2,
    report: 'estimate'
  })
})

test('a translation fitter short of evidence reaches no verdict', (t) => {
  const outcome = classifyFit(
    {
      engine: 'translation-nmtcpp',
      result: {
        status: 'error',
        reason: 'insufficient-evidence',
        backend: 'Vulkan0',
        modelBytes: 40 * 1024 ** 2,
        requiredBytes: 672 * 1024 ** 2,
        freeBytes: 512 * 1024 ** 2,
        report: 'estimate'
      }
    },
    PROVENANCE
  )

  t.is(outcome.verdict, 'unknown')
  t.is(outcome.reason, 'insufficient-evidence')
  t.absent(outcome.projection)
})

test('an ocr projection carries its weights and no working memory', (t) => {
  const outcome = classifyFit(
    {
      engine: 'ocr-ggml',
      result: {
        status: 'fits',
        reason: 'fits',
        deviceName: 'CPU',
        deviceBytes: 96 * 1024 ** 2,
        hostBytes: 0,
        weightsBytes: 96 * 1024 ** 2,
        deviceFreeBytes: 8 * 1024 ** 3,
        deviceTotalBytes: 16 * 1024 ** 3,
        report: 'table'
      }
    },
    PROVENANCE
  )

  t.is(outcome.engine, 'ocr-ggml')
  t.is(outcome.verdict, 'fit')
  t.absent(outcome.plan)
  t.alike(outcome.projection, {
    deviceName: 'CPU',
    deviceBytes: 96 * 1024 ** 2,
    hostBytes: 0,
    deviceFreeBytes: 8 * 1024 ** 3,
    deviceTotalBytes: 16 * 1024 ** 3,
    report: 'table',
    weightsBytes: 96 * 1024 ** 2
  })
})
