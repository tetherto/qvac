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

test('MOSS sound-effect fit rejects missing workload and invalid load controls', async (t) => {
  await t.exception(TTSGgml.assessFit(request({ prompt: undefined })))
  await t.exception(TTSGgml.assessFit(request({ seconds: undefined })))
  await t.exception(TTSGgml.assessFit(request({ seconds: NaN })))
  await t.exception(TTSGgml.assessFit(request({ threads: -1 })))
  await t.exception(TTSGgml.assessFit(request({ useGPU: true, nGpuLayers: 0 })))
  await t.exception(TTSGgml.assessFit(request({ marginBytes: -1 })))
})

test('MOSS sound-effect fit rejects unreadable models', async (t) => {
  await t.exception(TTSGgml.assessFit(request()), /model-unreadable/)
})

test(
  'MOSS sound-effect fit projects real-model CPU workloads',
  {
    skip: !process.env.QVAC_TEST_MOSS_SFX_GGUF
  },
  async (t) => {
    const model = process.env.QVAC_TEST_MOSS_SFX_GGUF
    const cfg = { mossSoundEffectPath: model }
    const fit = await TTSGgml.assessFit(request(cfg))
    t.ok(fit.status === 'fits' || fit.status === 'does-not-fit')
    t.is(fit.devices.length, 1, 'a CPU load is one row')
    t.ok(fit.devices[0].unified, 'the CPU row is the host')
    t.ok(fit.devices[0].usedBytes > 0)
    const shorter = await TTSGgml.assessFit(request({ ...cfg, seconds: 1 }))
    t.ok(shorter.devices[0].usedBytes <= fit.devices[0].usedBytes, 'a shorter clip needs no more')
    const noHeadroom = await TTSGgml.assessFit(request({ ...cfg, marginBytes: Number.MAX_VALUE }))
    t.is(noHeadroom.status, 'does-not-fit')
    await t.exception(TTSGgml.assessFit(request({ ...cfg, seconds: 0 })), /invalid-arguments/)
  }
)
