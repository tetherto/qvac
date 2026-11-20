import test from 'brittle'

import { bciFitRequest } from '@/plugins/builtin/bci-whispercpp-transcription/fit'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'

function load(modelConfig: unknown, extra: Partial<FitLoad> = {}): FitLoad {
  return { modelPath: '/models/bci.bin', modelConfig, isShardedModel: false, ...extra }
}

function requestOf(plan: FitRequestPlan): Record<string, unknown> | undefined {
  return 'request' in plan ? (plan.request as Record<string, unknown>) : undefined
}

test('carries the embedder, the device, the decoder count and the duration', (t) => {
  const plan = bciFitRequest(
    load(
      {
        whisperConfig: { beamSize: 5, durationMs: 30_000 },
        contextParams: { useGpu: true, gpuDevice: 1 }
      },
      { artifacts: { embedderPath: '/models/bci-embedder.bin' } }
    )
  )

  t.alike(requestOf(plan), {
    modelPath: '/models/bci.bin',
    embedderPath: '/models/bci-embedder.bin',
    gpuLayers: 1,
    gpuDevice: 1,
    decoders: 5,
    audioSeconds: 30
  })
})

test('the GPU is on unless the load turns it off', (t) => {
  t.is(requestOf(bciFitRequest(load({})))?.['gpuLayers'], 1)
  t.is(requestOf(bciFitRequest(load({ contextParams: { useGpu: false } })))?.['gpuLayers'], 0)
})
