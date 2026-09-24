import test from 'brittle'

import { classifyFit } from '@/resources/model-fit/native-probe/classify-fit'
import type { FitProbeResult } from '@/resources/model-fit/native-probe/engine-fit'

const PROVENANCE = { basis: 'native-probe', estimatorVersion: 'native-probe-v1' } as const

function device(name: string, modelBytes: number) {
  return {
    name,
    totalBytes: 24 * 1024 ** 3,
    freeBytes: 20 * 1024 ** 3,
    modelBytes,
    contextBytes: 0,
    computeBytes: 0
  }
}

function llama(
  devices: ReturnType<typeof device>[],
  status: 'fits' | 'does-not-fit' | 'error' = 'fits',
  reason = 'fits'
): FitProbeResult {
  return {
    engine: 'llm-llamacpp',
    result: {
      status,
      reason,
      gpuLayers: 32,
      ctxSize: 4096,
      devices,
      deviceBytes: 5 * 1024 ** 3,
      hostBytes: 0,
      trainCtxSize: 8192,
      expertCount: 0
    }
  }
}

test('the host row is not a device the offload spans', (t) => {
  const outcome = classifyFit(
    llama([device('Metal', 4 * 1024 ** 3), device('host', 1024 ** 3)]),
    PROVENANCE
  )

  t.is(outcome.plan?.nGpuDevices, 1)
  t.is(outcome.projection?.deviceName, 'Metal')
})

test('a device holding no weights is not counted', (t) => {
  const outcome = classifyFit(
    llama([device('CUDA0', 5 * 1024 ** 3), device('CUDA1', 0), device('host', 0)]),
    PROVENANCE
  )

  t.is(outcome.plan?.nGpuDevices, 1)
})

// The fitter assigns to the CPU backend device like any other, but its demand
// is host memory, so it is not a device the offload spans.
test('the CPU backend device is not a GPU the offload spans', (t) => {
  const outcome = classifyFit(
    llama([device('Metal', 4 * 1024 ** 3), device('CPU', 1024 ** 3), device('host', 1024 ** 3)]),
    PROVENANCE
  )

  t.is(outcome.plan?.nGpuDevices, 1)
  t.is(outcome.projection?.deviceName, 'Metal')
})

test('a wholly CPU-resident load spans no GPU', (t) => {
  const outcome = classifyFit(
    llama([device('CPU', 5 * 1024 ** 3), device('host', 5 * 1024 ** 3)]),
    PROVENANCE
  )

  t.is(outcome.plan?.nGpuDevices, 0)
  t.absent(outcome.projection?.deviceName)
})

test('a placement is reported only where the load fits', (t) => {
  const outcome = classifyFit(
    llama([device('Metal', 4 * 1024 ** 3)], 'does-not-fit', 'does-not-fit'),
    PROVENANCE
  )

  t.is(outcome.verdict, 'does-not-fit')
  t.absent(outcome.plan)
  // The figures matter most where the load does not fit.
  t.is(outcome.projection?.deviceBytes, 5 * 1024 ** 3)
})

test('an engine error carries no figures', (t) => {
  const outcome = classifyFit(llama([], 'error', 'model-unreadable'), PROVENANCE)

  t.is(outcome.verdict, 'unknown')
  t.is(outcome.reason, 'model-unreadable')
  t.absent(outcome.projection)
  t.absent(outcome.plan)
})

test('the diffusion placement stands in for a reason string', (t) => {
  const base = {
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
    { engine: 'diffusion-cpp', result: { ...base, status: 'error', changed: false } },
    PROVENANCE
  )
  t.is(unreadable.verdict, 'unknown')
  t.is(unreadable.reason, 'model-unreadable')
})

test('a speech projection carries the device the engine measured', (t) => {
  const outcome = classifyFit(
    {
      engine: 'tts-ggml',
      result: {
        status: 'fits',
        reason: 'fits',
        modelVariant: 'chatterbox-t3-turbo',
        deviceName: 'Metal',
        deviceIsCpu: false,
        deviceSharesHostMemory: true,
        deviceFreeBytes: 20 * 1024 ** 3,
        deviceTotalBytes: 24 * 1024 ** 3,
        deviceBytes: 2 * 1024 ** 3,
        weightsBytes: 1024 ** 3,
        stateBytes: 0,
        lmComputeBytes: 0,
        codecComputeBytes: 0,
        hostBytes: 128 * 1024 ** 2,
        report: 'table'
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
    deviceTotalBytes: 24 * 1024 ** 3,
    report: 'table',
    weightsBytes: 1024 ** 3,
    contextBytes: 0,
    computeBytes: 0
  })
})

test('the llama breakdown sums every device the demand is charged to', (t) => {
  const rows = [
    { ...device('CUDA0', 3 * 1024 ** 3), contextBytes: 1024 ** 3, computeBytes: 256 * 1024 ** 2 },
    { ...device('CUDA1', 2 * 1024 ** 3), contextBytes: 512 * 1024 ** 2, computeBytes: 0 },
    { ...device('host', 1024 ** 3), contextBytes: 1024 ** 3, computeBytes: 1024 ** 3 }
  ]

  const outcome = classifyFit(llama(rows), PROVENANCE)

  t.is(outcome.projection?.weightsBytes, 5 * 1024 ** 3)
  t.is(outcome.projection?.contextBytes, 1536 * 1024 ** 2)
  t.is(outcome.projection?.computeBytes, 256 * 1024 ** 2)
})

test('an engine reporting only a total has no breakdown', (t) => {
  const outcome = classifyFit(
    {
      engine: 'audiogen-ggml',
      result: {
        status: 'fits',
        reason: 'fits',
        modelName: 'ace-step',
        isTurbo: false,
        deviceName: 'Metal',
        deviceIsCpu: false,
        deviceSharesHostMemory: true,
        deviceFreeBytes: 20 * 1024 ** 3,
        deviceTotalBytes: 24 * 1024 ** 3,
        deviceBytes: 3 * 1024 ** 3,
        hostBytes: 0,
        hostFreeBytes: 12 * 1024 ** 3,
        hostTotalBytes: 24 * 1024 ** 3,
        stagesResident: false,
        report: 'table'
      }
    },
    PROVENANCE
  )

  t.absent(outcome.projection?.weightsBytes)
  t.absent(outcome.projection?.contextBytes)
  t.absent(outcome.projection?.computeBytes)
  t.is(outcome.projection?.deviceBytes, 3 * 1024 ** 3)
})
