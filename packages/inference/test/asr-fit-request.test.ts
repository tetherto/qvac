import test from 'brittle'

import {
  mossTranscribeFitRequest,
  parakeetFitRequest,
  whisperFitRequest
} from '@/plugins/builtin/asr-ggml/fit'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'

function load(modelPath: string, modelConfig: unknown, extra: Partial<FitLoad> = {}): FitLoad {
  return { modelPath, modelConfig, isShardedModel: false, ...extra }
}

function requestOf(plan: FitRequestPlan): Record<string, unknown> | undefined {
  return 'request' in plan ? (plan.request as Record<string, unknown>) : undefined
}

test('whisper: carries the VAD model, flash attention, and the decoder count', (t) => {
  const plan = whisperFitRequest(
    load(
      '/models/whisper.bin',
      {
        strategy: 'beam_search',
        beam_search_beam_size: 5,
        contextParams: { use_gpu: true, flash_attn: true, gpu_device: 1 }
      },
      { artifacts: { vadModelPath: '/models/vad.bin' } }
    )
  )

  t.alike(requestOf(plan), {
    engine: 'whisper',
    modelPath: '/models/whisper.bin',
    gpuLayers: 1,
    vadModelPath: '/models/vad.bin',
    flashAttn: true,
    gpuDevice: 1,
    decoders: 5
  })
})

test('whisper: a CPU load asks the fitter for no offload', (t) => {
  const plan = whisperFitRequest(load('/models/whisper.bin', { contextParams: { use_gpu: false } }))
  t.is(requestOf(plan)?.['gpuLayers'], 0)
})

test('whisper: the transcribe duration bounds the projection', (t) => {
  const plan = whisperFitRequest(load('/models/whisper.bin', { duration_ms: 90_000 }))
  t.is(requestOf(plan)?.['audioSeconds'], 90)
})

test('whisper: the default decoder sentinel is left to the engine', (t) => {
  const plan = whisperFitRequest(
    load('/models/whisper.bin', { strategy: 'greedy', greedy_best_of: -1 })
  )
  t.ok(requestOf(plan))
  t.absent('decoders' in (requestOf(plan) ?? {}))
})

test('parakeet: carries threads and the streaming chunk cadence', (t) => {
  const plan = parakeetFitRequest(
    load('/models/parakeet.gguf', {
      useGPU: true,
      maxThreads: 6,
      streaming: true,
      streamingChunkMs: 320
    })
  )

  t.alike(requestOf(plan), {
    engine: 'parakeet',
    modelPath: '/models/parakeet.gguf',
    gpuLayers: 1,
    threads: 6,
    nemotronChunkMs: 320
  })
})

test('parakeet: a streaming window the fitter cannot represent is unknown', (t) => {
  for (const key of ['streamingLeftContextMs', 'streamingHistoryMs']) {
    const plan = parakeetFitRequest(
      load('/models/parakeet.gguf', { useGPU: true, streaming: true, [key]: 8000 })
    )
    t.ok('unknown' in plan && plan.unknown.includes('cannot represent'), key)
  }
})

test('parakeet: those windows bind nothing outside a streaming load', (t) => {
  const plan = parakeetFitRequest(
    load('/models/parakeet.gguf', { useGPU: true, streamingLeftContextMs: 8000 })
  )
  t.ok(requestOf(plan))
})

test('parakeet: an explicit long-form window reaches the projection', (t) => {
  const plan = parakeetFitRequest(
    load('/models/transcribepsy-250m-eu-sub.gguf', {
      longFormWindowFrames: 375,
      longFormContextFrames: -1
    })
  )

  t.alike(requestOf(plan), {
    engine: 'parakeet',
    modelPath: '/models/transcribepsy-250m-eu-sub.gguf',
    gpuLayers: 0,
    longFormWindowFrames: 375,
    longFormContextFrames: -1
  })
})

test('parakeet: prewarm and energy-VAD tuning stay out of the projection', (t) => {
  // The addon's fit request has no field for either: the prewarm pass encodes
  // `prewarmAudioSeconds` of audio, well inside the 300 s the projection
  // covers by default, and the energy detector adds no graph of its own.
  const plan = parakeetFitRequest(
    load('/models/parakeet.gguf', {
      streaming: true,
      streamingEnergyVad: true,
      streamingEnergyVadThresholdDb: -40,
      streamingEnergyVadWindowMs: 50,
      streamingEnergyVadHangoverMs: 300,
      prewarm: true,
      prewarmAudioSeconds: 2
    })
  )

  t.alike(requestOf(plan), {
    engine: 'parakeet',
    modelPath: '/models/parakeet.gguf',
    gpuLayers: 0
  })
})

test('parakeet: a non-streaming load holds no live session to size', (t) => {
  const plan = parakeetFitRequest(
    load('/models/parakeet.gguf', { useGPU: true, streamingChunkMs: 320 })
  )
  t.ok(requestOf(plan))
  t.absent('nemotronChunkMs' in (requestOf(plan) ?? {}))
})

test('MOSS: projects the declared recording and matching decoding options', (t) => {
  const plan = mossTranscribeFitRequest(
    load(
      '/models/moss.gguf',
      { useGPU: true, maxThreads: 4, backend: 'cuda', backendsDir: '/backends' },
      { transcriptionWorkload: { audioSeconds: 90, hotwords: ['Erin'], maxNewTokens: 0 } }
    )
  )

  t.alike(requestOf(plan), {
    engine: 'moss-transcribe',
    modelPath: '/models/moss.gguf',
    audioSeconds: 90,
    hotwords: ['Erin'],
    maxNewTokens: 0,
    gpuLayers: 1,
    backend: 'cuda',
    threads: 4,
    backendsDir: '/backends'
  })
})

test('MOSS: no workload is unknown, and the default load stays on the CPU', (t) => {
  t.ok('unknown' in mossTranscribeFitRequest(load('/models/moss.gguf', {})))

  const plan = mossTranscribeFitRequest(
    load(
      '/models/moss.gguf',
      {},
      { transcriptionWorkload: { audioSeconds: 30, prompt: 'Transcribe.' } }
    )
  )
  t.is(requestOf(plan)?.['gpuLayers'], 0)
})
