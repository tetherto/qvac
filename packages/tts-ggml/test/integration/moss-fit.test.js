'use strict'

const path = require('bare-path')
const process = require('bare-process')
const test = require('brittle')
const TTSGgml = require('@qvac/tts-ggml')

test('MOSS fit requires explicit, representable workload counts', async (t) => {
  const request = {
    engineType: 'moss',
    mossBackbonePath: '/models/moss-tts-delay.gguf',
    mossCodecDecoderPath: '/models/moss-codec-decoder.gguf',
    promptRows: 128,
    referenceSamples: 0,
    streaming: false
  }
  for (const invalid of [NaN, Infinity, -1, 0.5, 2147483648]) {
    await t.exception(TTSGgml.assessFit({ ...request, promptRows: invalid }))
    await t.exception(TTSGgml.assessFit({ ...request, referenceSamples: invalid }))
  }
  await t.exception(TTSGgml.assessFit({ ...request, promptRows: undefined }))
  await t.exception(TTSGgml.assessFit({ ...request, streaming: undefined }))
  await t.exception(TTSGgml.assessFit({ ...request, threads: -1 }))
  await t.exception(TTSGgml.assessFit({ ...request, durationTokens: -1 }))
  await t.exception(TTSGgml.assessFit({ ...request, streamChunkTokens: -1 }))
  await t.exception(TTSGgml.assessFit({ ...request, useGPU: true, nGpuLayers: 0 }))
})

test('MOSS metadata-only fit covers batch, streaming and cloning', async (t) => {
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
  const used = (fit) => fit.devices.reduce((total, row) => total + row.usedBytes, 0)

  const batch = await TTSGgml.assessFit(request)
  t.ok(batch.status === 'fits' || batch.status === 'does-not-fit', JSON.stringify(batch))
  t.ok(batch.devices[0].usedBytes > 0)
  const stream = await TTSGgml.assessFit({ ...request, streaming: true })
  t.ok(stream.status === 'fits' || stream.status === 'does-not-fit', JSON.stringify(stream))
  const cloning = await TTSGgml.assessFit({
    ...request,
    mossCodecEncoderPath: path.join(modelDir, 'moss-codec-encoder-f16.gguf'),
    referenceSamples: 24000
  })
  t.ok(cloning.status === 'fits' || cloning.status === 'does-not-fit', JSON.stringify(cloning))
  t.ok(used(cloning) > used(batch), 'the encoder adds to the demand')
})
