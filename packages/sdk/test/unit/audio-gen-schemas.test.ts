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

test('audioGen client params validate ACE-Step 0.2.1 sampling, DCW, and cover controls', (t) => {
  t.ok(
    audioGenClientParamsSchema.safeParse({
      modelId: 'model-1',
      caption: 'slow blues with warm electric guitar',
      lmTemperature: 0.85,
      lmTopP: 0.9,
      lmTopK: 0,
      lmCfgScale: 2,
      lmPhase1: true,
      dcwEnabled: true,
      dcwScaler: 0.05,
      dcwHighScaler: 0.02,
      taskType: 'text2music',
      audioCoverStrength: 1,
      coverNoiseStrength: 0.75
    }).success
  )
  t.is(
    audioGenClientParamsSchema.safeParse({ modelId: 'model-1', caption: 'x', lmTopP: 1.5 }).success,
    false,
    'lmTopP is bounded to [0, 1]'
  )
  t.is(
    audioGenClientParamsSchema.safeParse({ modelId: 'model-1', caption: 'x', lmTopK: 2.5 }).success,
    false,
    'lmTopK must be an integer'
  )
  t.is(
    audioGenClientParamsSchema.safeParse({
      modelId: 'model-1',
      caption: 'x',
      coverNoiseStrength: -0.1
    }).success,
    false,
    'coverNoiseStrength is bounded to [0, 1]'
  )
  t.is(
    audioGenClientParamsSchema.safeParse({ modelId: 'model-1', caption: 'x', taskType: 'cover' })
      .success,
    false,
    'the reserved FSQ cover task is not offered'
  )
})

test('audioGen client params normalize reference and source audio inputs', (t) => {
  const fromPaths = audioGenClientParamsSchema.parse({
    modelId: 'model-1',
    caption: 'orchestral arrangement with dramatic strings',
    taskType: 'cover-nofsq',
    sourceAudio: '/tmp/source.wav',
    referenceAudio: '/tmp/reference.mp3'
  })
  t.alike(fromPaths.sourceAudio, { type: 'filePath', value: '/tmp/source.wav' })
  t.alike(fromPaths.referenceAudio, { type: 'filePath', value: '/tmp/reference.mp3' })

  const pcm = new Float32Array([0.25, -0.25])
  const fromBytes = audioGenClientParamsSchema.parse({
    modelId: 'model-1',
    caption: 'slow blues with warm electric guitar',
    referenceAudio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  })
  t.is(fromBytes.referenceAudio?.type, 'base64')
  t.is(fromBytes.referenceAudio?.value, Buffer.from(pcm.buffer).toString('base64'))

  const fromUint8Array = audioGenClientParamsSchema.parse({
    modelId: 'model-1',
    caption: 'slow blues with warm electric guitar',
    referenceAudio: new Uint8Array(pcm.buffer)
  })
  t.alike(fromUint8Array.referenceAudio, fromBytes.referenceAudio, 'plain Uint8Array is accepted')

  t.is(
    audioGenClientParamsSchema.safeParse({ modelId: 'model-1', caption: 'x', referenceAudio: '' })
      .success,
    false,
    'empty path is rejected'
  )
})

test('cover tasks require sourceAudio on both client and wire schemas', (t) => {
  const missingSource = audioGenClientParamsSchema.safeParse({
    modelId: 'model-1',
    caption: 'orchestral arrangement with dramatic strings',
    taskType: 'cover-nofsq'
  })
  t.is(missingSource.success, false)
  t.ok(
    !missingSource.success &&
      missingSource.error.issues.some(
        (issue) => issue.path[0] === 'sourceAudio' && /requires sourceAudio/.test(issue.message)
      )
  )
  t.is(
    audioGenStreamRequestSchema.safeParse({
      type: 'audioGenStream',
      modelId: 'model-1',
      caption: 'orchestral arrangement with dramatic strings',
      taskType: 'cover-nofsq'
    }).success,
    false
  )
  t.ok(
    audioGenStreamRequestSchema.safeParse({
      type: 'audioGenStream',
      modelId: 'model-1',
      caption: 'orchestral arrangement with dramatic strings',
      taskType: 'cover-nofsq',
      sourceAudio: { type: 'filePath', value: '/tmp/source.wav' },
      referenceAudio: { type: 'base64', value: 'AAAAAAAAAAA=' }
    }).success
  )
})

test('cover-nofsq only accepts audioCoverStrength 1 while the engine lacks context switching', (t) => {
  const base = {
    modelId: 'model-1',
    caption: 'orchestral arrangement with dramatic strings',
    taskType: 'cover-nofsq',
    sourceAudio: '/tmp/source.wav'
  }
  t.ok(audioGenClientParamsSchema.safeParse(base).success, 'omitted strength is accepted')
  t.ok(
    audioGenClientParamsSchema.safeParse({ ...base, audioCoverStrength: 1 }).success,
    'explicit 1 is accepted'
  )
  const partial = audioGenClientParamsSchema.safeParse({ ...base, audioCoverStrength: 0.5 })
  t.is(partial.success, false, 'values below 1 are rejected for cover-nofsq')
  t.ok(
    !partial.success &&
      partial.error.issues.some(
        (issue) =>
          issue.path[0] === 'audioCoverStrength' &&
          /requires audioCoverStrength 1/.test(issue.message)
      )
  )
  t.ok(
    audioGenClientParamsSchema.safeParse({
      modelId: 'model-1',
      caption: 'ambient electronic music',
      audioCoverStrength: 0.5
    }).success,
    'text2music is not constrained by the cover-only rule'
  )
  t.is(
    audioGenStreamRequestSchema.safeParse({
      type: 'audioGenStream',
      modelId: 'model-1',
      caption: 'orchestral arrangement with dramatic strings',
      taskType: 'cover-nofsq',
      sourceAudio: { type: 'filePath', value: '/tmp/source.wav' },
      audioCoverStrength: 0.25
    }).success,
    false,
    'the wire schema enforces the same rule'
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
