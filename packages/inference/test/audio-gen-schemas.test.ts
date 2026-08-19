import test from 'brittle'
import {
  audioGenClientParamsSchema,
  audioGenConfigSchema,
  audioGenStreamRequestSchema,
  audioGenStreamResponseSchema
} from '@/schemas/audio-gen'
import { loadModelOptionsToRequestSchema } from '@/schemas/load-model'
import { ModelType, normalizeModelType } from '@/schemas/model-types'

const modelConfig = {
  textEncModelSrc: 'text-encoder.gguf',
  lmModelSrc: 'lm.gguf',
  ditModelSrc: 'dit.gguf',
  vaeModelSrc: 'vae.gguf'
}

test('AudioGen model type supports canonical value and alias', (t) => {
  t.is(ModelType.audiogenGgml, 'audiogen-ggml')
  t.is(normalizeModelType('audiogen'), ModelType.audiogenGgml)
})

test('audioGenConfigSchema requires all four model sources', (t) => {
  t.ok(audioGenConfigSchema.safeParse(modelConfig).success)
  t.is(
    audioGenConfigSchema.safeParse({
      textEncModelSrc: 'text-encoder.gguf',
      lmModelSrc: 'lm.gguf',
      ditModelSrc: 'dit.gguf'
    }).success,
    false
  )
})

test('AudioGen load transform permits omitted primary modelSrc', (t) => {
  const request = loadModelOptionsToRequestSchema.parse({
    modelType: 'audiogen',
    modelConfig
  })

  t.is(request.modelType, ModelType.audiogenGgml)
  t.is(request.modelSrc, '')
  t.alike(request.modelConfig, modelConfig)
})

test('audioGen client params validate generation controls', (t) => {
  t.ok(
    audioGenClientParamsSchema.safeParse({
      modelId: 'model-1',
      caption: 'ambient electronic music',
      seed: 42,
      bpm: 120,
      duration: 10
    }).success
  )
  t.is(
    audioGenClientParamsSchema.safeParse({
      modelId: 'model-1',
      caption: ' ',
      bpm: 0
    }).success,
    false
  )
})

test('audioGenStreamRequestSchema accepts an optional requestId', (t) => {
  const request = audioGenStreamRequestSchema.parse({
    type: 'audioGenStream',
    modelId: 'model-1',
    caption: 'ambient electronic music',
    requestId: 'audio-request-1'
  })

  t.is(request.requestId, 'audio-request-1')
  t.ok(
    audioGenStreamRequestSchema.safeParse({
      type: 'audioGenStream',
      modelId: 'model-1',
      caption: 'ambient electronic music'
    }).success
  )
})

test('audioGenStreamResponseSchema accepts progress, PCM, and terminal frames', (t) => {
  t.ok(
    audioGenStreamResponseSchema.safeParse({
      type: 'audioGenStream',
      progress: { stage: 'dit', step: 2, total: 8 }
    }).success
  )
  t.ok(
    audioGenStreamResponseSchema.safeParse({
      type: 'audioGenStream',
      data: 'AAECAw==',
      sampleRate: 44100,
      channels: 2,
      bitsPerSample: 16
    }).success
  )
  const terminal = audioGenStreamResponseSchema.parse({
    type: 'audioGenStream',
    done: true,
    stopReason: 'completed',
    stats: {
      audioDurationMs: 10000,
      totalTimeMs: 5000,
      realTimeFactor: 0.5,
      backendDevice: 1,
      backendId: 1
    }
  })
  t.alike(terminal.stats, {
    audioDurationMs: 10000,
    totalTimeMs: 5000,
    realTimeFactor: 0.5,
    backendDevice: 1,
    backendId: 1
  })
  t.ok(
    audioGenStreamResponseSchema.safeParse({
      type: 'audioGenStream',
      done: true,
      stopReason: 'cancelled'
    }).success
  )
})
