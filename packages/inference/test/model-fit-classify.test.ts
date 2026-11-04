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

type LlamaProbeResult = Extract<FitProbeResult, { engine: 'llm-llamacpp' }>['result']

function llama(
  devices: ReturnType<typeof device>[],
  status: LlamaProbeResult['status'] = 'fits'
): FitProbeResult {
  return {
    engine: 'llm-llamacpp',
    result: {
      status,
      devices,
      stats: { gpuLayers: 32, ctxSize: 4096 }
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
    {
      engine: 'tts-ggml',
      result: {
        status: 'fits',
        devices: [device('Metal', 2 * 1024 ** 3), device('CPU', 128 * 1024 ** 2)],
        stats: {}
      }
    },
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

test('an engine reporting only a total has no breakdown', (t) => {
  const outcome = classifyFit(
    {
      engine: 'audiogen-ggml',
      result: {
        status: 'fits',
        devices: [device('Metal', 3 * 1024 ** 3)],
        stats: {}
      }
    },
    PROVENANCE
  )

  t.absent(outcome.projection?.weightsBytes)
  t.absent(outcome.projection?.contextBytes)
  t.absent(outcome.projection?.computeBytes)
  t.is(outcome.projection?.deviceBytes, 3 * 1024 ** 3)
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
