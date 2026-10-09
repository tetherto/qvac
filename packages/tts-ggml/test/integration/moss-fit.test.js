'use strict'

const path = require('bare-path')
const process = require('bare-process')
const test = require('brittle')
const TTSGgml = require('@qvac/tts-ggml')

test('MOSS fit requires explicit, representable workload counts', (t) => {
  const request = {
    engineType: 'moss',
    mossBackbonePath: '/models/moss-tts-delay.gguf',
    mossCodecDecoderPath: '/models/moss-codec-decoder.gguf',
    promptRows: 128,
    referenceSamples: 0,
    streaming: false
  }
  for (const invalid of [NaN, Infinity, -1, 0.5, 2147483648]) {
    t.exception(() => TTSGgml.assessFit({ ...request, promptRows: invalid }))
    t.exception(() => TTSGgml.assessFit({ ...request, referenceSamples: invalid }))
  }
  t.exception(() => TTSGgml.assessFit({ ...request, promptRows: undefined }))
  t.exception(() => TTSGgml.assessFit({ ...request, streaming: undefined }))
  t.exception(() => TTSGgml.assessFit({ ...request, threads: -1 }))
  t.exception(() => TTSGgml.assessFit({ ...request, durationTokens: -1 }))
  t.exception(() => TTSGgml.assessFit({ ...request, streamChunkTokens: -1 }))
  t.exception(() => TTSGgml.assessFit({ ...request, useGPU: true, nGpuLayers: 0 }))
})

test('MOSS metadata-only fit covers batch, streaming and cloning', (t) => {
  const modelDir = process.env.QVAC_TEST_MOSS_MODEL_DIR
  if (!modelDir) {
    t.comment('Set QVAC_TEST_MOSS_MODEL_DIR to exercise real MOSS GGUFs')
    return
  }
  const request = {
    engineType: 'moss',
    mossBackbonePath: path.join(modelDir, 'moss-tts-delay-f16.gguf'),
    mossCodecDecoderPath: path.join(modelDir, 'moss-codec-decoder-f16.gguf'),
    promptRows: 128,
    referenceSamples: 0,
    streaming: false
  }
  const batch = TTSGgml.assessFit(request)
  t.not(batch.status, 'error', batch.report)
  t.ok(batch.weightsBytes > 0)
  t.ok(batch.lmComputeBytes > 0)
  t.ok(batch.codecComputeBytes > 0)
  const stream = TTSGgml.assessFit({ ...request, streaming: true })
  t.not(stream.status, 'error', stream.report)
  const cloning = TTSGgml.assessFit({
    ...request,
    mossCodecEncoderPath: path.join(modelDir, 'moss-codec-encoder-f16.gguf'),
    referenceSamples: 24000
  })
  t.not(cloning.status, 'error', cloning.report)
  t.ok(cloning.weightsBytes > batch.weightsBytes)
})
