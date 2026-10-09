'use strict'

const test = require('brittle')
const process = require('bare-process')
const ASRGgml = require('../../index.js')

const missing = '/nonexistent/moss-transcribe.gguf'

test('MOSS fit requires a model and an explicit positive duration', (t) => {
  for (const audioSeconds of [undefined, 0, -1, NaN, Infinity]) {
    t.exception(() =>
      ASRGgml.assessFit({ engine: 'moss-transcribe', modelPath: missing, audioSeconds })
    )
  }
  t.exception(() =>
    ASRGgml.assessFit({ engine: 'moss-transcribe', modelPath: '', audioSeconds: 30 })
  )
})

test('MOSS fit validates the same transcription options as run', (t) => {
  const base = { engine: 'moss-transcribe', modelPath: missing, audioSeconds: 30 }
  for (const options of [
    { prompt: 'custom', hotwords: ['QVAC'] },
    { hotwords: [42] },
    { maxNewTokens: -1 },
    { maxNewTokens: 1.5 },
    { maxNewTokens: 2 ** 32 },
    { threads: -1 },
    { threads: 1.5 },
    { gpuLayers: Infinity },
    { marginBytes: -1 },
    { marginBytes: NaN }
  ]) {
    t.exception(() => ASRGgml.assessFit({ ...base, ...options }))
  }
})

test('MOSS fit reports an unreadable model as an outcome', (t) => {
  const fit = ASRGgml.assessFit({ engine: 'moss-transcribe', modelPath: missing, audioSeconds: 30 })
  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
  t.is(fit.modelType, 'moss-transcribe')
})

test(
  'MOSS fit projects weights, graphs and KV without loading the model',
  { skip: !process.env.QVAC_TEST_MOSS_TRANSCRIBE_GGUF },
  (t) => {
    const request = {
      engine: 'moss-transcribe',
      modelPath: process.env.QVAC_TEST_MOSS_TRANSCRIBE_GGUF,
      audioSeconds: 30,
      maxNewTokens: 64,
      gpuLayers: 0,
      threads: 4,
      marginBytes: 0
    }
    const fit = ASRGgml.assessFit(request)
    t.ok(fit.status === 'fits' || fit.status === 'does-not-fit', fit.report)
    t.is(fit.modelType, 'moss-transcribe')
    t.ok(fit.deviceIsCpu)
    t.ok(fit.deviceSharesHostMemory)
    t.ok(fit.weightsBytes > 0)
    t.ok(fit.encoderComputeBytes > 0)
    t.ok(fit.decoderStateBytes > 0)
    t.ok(fit.hostBytes > 0)
    t.is(
      fit.deviceBytes,
      fit.weightsBytes + fit.encoderComputeBytes + fit.decoderStateBytes + fit.decoderComputeBytes
    )
    const longer = ASRGgml.assessFit({ ...request, audioSeconds: 90 })
    t.not(longer.status, 'error', longer.report)
    t.ok(longer.decoderStateBytes > fit.decoderStateBytes)
    t.ok(longer.hostBytes > fit.hostBytes)
    const margin = ASRGgml.assessFit({ ...request, marginBytes: Number.MAX_VALUE })
    t.is(margin.status, 'does-not-fit')
    t.is(margin.reason, 'does-not-fit')
  }
)
