'use strict'

const test = require('brittle')
const process = require('bare-process')
const TTSGgml = require('@qvac/tts-ggml')

function request(overrides = {}) {
  return {
    engineType: 'moss-sfx',
    mossSoundEffectPath: '/nonexistent/moss-sfx.gguf',
    prompt: 'Rain on a tin roof.',
    seconds: 8,
    useGPU: false,
    ...overrides
  }
}

test('MOSS sound-effect fit rejects missing workload and invalid load controls', (t) => {
  t.exception(() => TTSGgml.assessFit(request({ prompt: undefined })))
  t.exception(() => TTSGgml.assessFit(request({ seconds: undefined })))
  t.exception(() => TTSGgml.assessFit(request({ seconds: NaN })))
  t.exception(() => TTSGgml.assessFit(request({ threads: -1 })))
  t.exception(() => TTSGgml.assessFit(request({ useGPU: true, nGpuLayers: 0 })))
  t.exception(() => TTSGgml.assessFit(request({ marginBytes: -1 })))
})

test('MOSS sound-effect fit reports unreadable models', (t) => {
  const fit = TTSGgml.assessFit(request())
  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
  t.is(fit.modelVariant, 'moss-sfx')
})

test(
  'MOSS sound-effect fit projects real-model CPU workloads',
  {
    skip: !process.env.QVAC_TEST_MOSS_SFX_GGUF
  },
  (t) => {
    const model = process.env.QVAC_TEST_MOSS_SFX_GGUF
    const cfg = { mossSoundEffectPath: model }
    const fit = TTSGgml.assessFit(request(cfg))
    t.ok(fit.status === 'fits' || fit.status === 'does-not-fit')
    t.is(fit.modelVariant, 'moss-sfx')
    t.ok(fit.deviceIsCpu)
    t.ok(fit.deviceSharesHostMemory)
    t.ok(fit.weightsBytes > 0)
    t.ok(fit.lmComputeBytes > 0)
    t.ok(fit.hostBytes > 0)
    t.is(
      fit.deviceBytes,
      fit.weightsBytes + fit.stateBytes + fit.lmComputeBytes + fit.codecComputeBytes
    )
    const shorter = TTSGgml.assessFit(request({ ...cfg, seconds: 1 }))
    t.is(shorter.weightsBytes, fit.weightsBytes)
    t.is(shorter.lmComputeBytes, fit.lmComputeBytes)
    const noHeadroom = TTSGgml.assessFit(request({ ...cfg, marginBytes: Number.MAX_VALUE }))
    t.is(noHeadroom.status, 'does-not-fit')
    const invalid = TTSGgml.assessFit(request({ ...cfg, seconds: 0 }))
    t.is(invalid.status, 'error')
    t.is(invalid.reason, 'invalid-arguments')
  }
)
