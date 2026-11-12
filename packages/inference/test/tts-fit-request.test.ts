import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'

import { ttsFitRequest } from '@/plugins/builtin/tts-ggml/fit'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'

function load(modelPath: string, modelConfig: unknown, extra: Partial<FitLoad> = {}): FitLoad {
  return { modelPath, modelConfig, isShardedModel: false, ...extra }
}

function requestOf(plan: FitRequestPlan): Record<string, unknown> | undefined {
  return 'request' in plan ? (plan.request as Record<string, unknown>) : undefined
}

test('chatterbox: carries the S3Gen checkpoint and the KV cache settings', (t) => {
  const plan = ttsFitRequest(
    load(
      '/models/t3.gguf',
      { useGPU: true, nCtx: 2048, kvCacheType: 'q8_0', backendsDir: '/backends' },
      { artifacts: { s3genPath: '/models/s3gen.gguf' } }
    )
  )

  t.alike(requestOf(plan), {
    engineType: 'chatterbox',
    t3ModelPath: '/models/t3.gguf',
    s3genModelPath: '/models/s3gen.gguf',
    nGpuLayers: 1,
    backendsDir: '/backends',
    nCtx: 2048,
    kvCacheType: 'q8_0'
  })
})

test('an explicit layer count wins over the GPU switch', (t) => {
  const plan = ttsFitRequest(load('/models/parler.gguf', { ttsEngine: 'parler', nGpuLayers: 0 }))
  t.is(requestOf(plan)?.['nGpuLayers'], 0)
})

test('a LavaSR stage is unknown, whichever engine it follows', (t) => {
  for (const key of ['lavasrEnhancerPath', 'lavasrDenoiserPath']) {
    const plan = ttsFitRequest(
      load(
        '/models/supertonic.gguf',
        { ttsEngine: 'supertonic', useGPU: true },
        {
          artifacts: { [key]: '/models/lavasr.gguf' }
        }
      )
    )
    t.ok('unknown' in plan && plan.unknown.includes('LavaSR'), key)
  }
})

test('MOSS: projects the declared workload and its load controls', (t) => {
  const plan = ttsFitRequest(
    load(
      '/models/moss.gguf',
      { ttsEngine: 'moss', useGPU: true, threads: 4, streamChunkTokens: 8 },
      {
        artifacts: {
          mossCodecDecoderPath: '/models/decoder.gguf',
          mossCodecEncoderPath: '/models/encoder.gguf'
        },
        ttsWorkload: { promptRows: 128, referenceSamples: 24000, streaming: true }
      }
    )
  )

  t.alike(requestOf(plan), {
    engineType: 'moss',
    mossBackbonePath: '/models/moss.gguf',
    mossCodecDecoderPath: '/models/decoder.gguf',
    mossCodecEncoderPath: '/models/encoder.gguf',
    nGpuLayers: 1,
    promptRows: 128,
    referenceSamples: 24000,
    streaming: true,
    threads: 4,
    streamChunkTokens: 8
  })
})

test('MOSS: no workload, or a reference without the encoder, is unknown', (t) => {
  const artifacts = { mossCodecDecoderPath: '/models/decoder.gguf' }
  t.ok('unknown' in ttsFitRequest(load('/models/moss.gguf', { ttsEngine: 'moss' }, { artifacts })))
  t.ok(
    'unknown' in
      ttsFitRequest(
        load(
          '/models/moss.gguf',
          { ttsEngine: 'moss' },
          {
            artifacts,
            ttsWorkload: { promptRows: 128, referenceSamples: 24000, streaming: false }
          }
        )
      )
  )
})

test('MOSS-SoundEffect: projects the declared clip', (t) => {
  const plan = ttsFitRequest(
    load(
      '/models/sfx.gguf',
      { ttsEngine: 'moss-sfx', steps: 20 },
      {
        ttsWorkload: { prompt: 'Rain on a tin roof.', seconds: 8 }
      }
    )
  )

  t.alike(requestOf(plan), {
    engineType: 'moss-sfx',
    mossSoundEffectPath: '/models/sfx.gguf',
    nGpuLayers: 0,
    prompt: 'Rain on a tin roof.',
    seconds: 8,
    steps: 20
  })
})

test('MOSS-Speech has no fitter', (t) => {
  t.ok('unknown' in ttsFitRequest(load('/models/speech.gguf', { ttsEngine: 'moss-speech' })))
})

test('CosyVoice: finds its companions beside the checkpoint', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-tts-fit-request-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const name of ['cv-flow-q8.gguf', 'cv-hift-f16.gguf', 'voice.gguf']) {
    fs.writeFileSync(path.join(dir, name), '')
  }
  const llm = path.join(dir, 'cv-llm-q8.gguf')

  t.alike(requestOf(ttsFitRequest(load(llm, { ttsEngine: 'cosyvoice3' }))), {
    engineType: 'cosyvoice3',
    cosyvoiceLlmModelPath: llm,
    cosyvoiceFlowModelPath: path.join(dir, 'cv-flow-q8.gguf'),
    cosyvoiceHiftModelPath: path.join(dir, 'cv-hift-f16.gguf'),
    cosyvoiceVoiceModelPath: path.join(dir, 'voice.gguf'),
    nGpuLayers: 0
  })

  fs.rmSync(path.join(dir, 'voice.gguf'))
  t.ok('unknown' in ttsFitRequest(load(llm, { ttsEngine: 'cosyvoice3' })), 'a missing companion')
})

test('the explicit backend selector reaches every fit request', (t) => {
  // The fitter resolves the same device the load would, so the projection
  // lands there rather than on the useGPU policy's pick.
  const supertonic = ttsFitRequest(
    load('/models/supertonic.gguf', { ttsEngine: 'supertonic', backend: 'MTL0' })
  )
  t.is(requestOf(supertonic)?.['backend'], 'MTL0')
  const parler = ttsFitRequest(load('/models/parler.gguf', { ttsEngine: 'parler', backend: 'cpu' }))
  t.is(requestOf(parler)?.['backend'], 'cpu')
  const chatterbox = ttsFitRequest(
    load(
      '/models/t3.gguf',
      { ttsEngine: 'chatterbox', backend: 'Vulkan0' },
      { artifacts: { s3genPath: '/models/s3gen.gguf' } }
    )
  )
  t.is(requestOf(chatterbox)?.['backend'], 'Vulkan0')
  t.is(
    'backend' in
      (requestOf(ttsFitRequest(load('/models/parler.gguf', { ttsEngine: 'parler' }))) ?? {}),
    false,
    'absent when unset'
  )
})

test('supertonic: carries the precision and f16 weight override the fitter sizes by', (t) => {
  const plan = ttsFitRequest(
    load('/models/supertonic3-q8_0.gguf', {
      ttsEngine: 'supertonic',
      precision: 'f16',
      f16Weights: 1,
      ttsNumInferenceSteps: 4
    })
  )
  t.alike(requestOf(plan), {
    engineType: 'supertonic',
    supertonicModelPath: '/models/supertonic3-q8_0.gguf',
    nGpuLayers: 0,
    precision: 'f16',
    f16Weights: 1,
    steps: 4
  })
})

test('parler: carries the decoder sidecar policy', (t) => {
  const plan = ttsFitRequest(
    load('/models/parler-mini-v1-q8_0.gguf', { ttsEngine: 'parler', coremlDecoder: true })
  )
  t.alike(requestOf(plan), {
    engineType: 'parler',
    parlerModelPath: '/models/parler-mini-v1-q8_0.gguf',
    nGpuLayers: 0,
    coremlDecoder: true
  })
})

test('MOSS: carries the context and generation budgets', (t) => {
  const plan = ttsFitRequest(
    load(
      '/models/moss.gguf',
      { ttsEngine: 'moss', nCtx: 8192, maxNewTokens: 4096 },
      {
        artifacts: { mossCodecDecoderPath: '/models/decoder.gguf' },
        ttsWorkload: { promptRows: 128, referenceSamples: 0, streaming: false }
      }
    )
  )
  const request = requestOf(plan)
  t.is(request?.['nCtx'], 8192)
  t.is(request?.['maxNewTokens'], 4096)
})
