'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
test('integration: automatic NVIDIA backend selection', { timeout: 1800000 }, async (t) => {
  const expectedBackend = process.env.QVAC_VLA_EXPECTED_BACKEND
  if (process.env.QVAC_VLA_BACKEND_SELECTION_SMOKE !== 'true') {
    t.comment('skipping dedicated backend selection workflow test')
    t.pass()
    return
  }

  t.ok(expectedBackend, 'expected backend is configured')
  if (!expectedBackend) return

  const { VlaModel, padState, preprocessImage } = require('../..')

  const modelPath = process.env.QVAC_VLA_MODEL
  t.ok(modelPath && fs.existsSync(modelPath), 'SmolVLA model is available')
  if (!modelPath || !fs.existsSync(modelPath)) return

  const model = new VlaModel({ files: { model: [path.resolve(modelPath)] } })
  try {
    await model.load({ backend: 'auto' })
    t.ok(model.backendName, 'backend name resolved')
    t.ok(model.backendName.toLowerCase().includes(expectedBackend), `${expectedBackend} selected`)

    const hp = model.hparams
    const size = hp.visionImageSize
    const pixels = new Uint8Array(size * size * 3).fill(128)
    const image = preprocessImage(pixels, size, size, { size })
    const tokens = new Int32Array(hp.tokenizerMaxLength)
    const mask = new Uint8Array(hp.tokenizerMaxLength)
    tokens[0] = 1
    mask[0] = 1

    const response = await model.run({
      images: [image, image],
      imgWidth: size,
      imgHeight: size,
      state: padState([0, 0, 0, 0, 0, 0], hp.maxStateDim),
      tokens,
      mask,
      noise: new Float32Array(hp.chunkSize * hp.maxActionDim)
    })
    const { actions } = await response.await()
    t.is(actions.length, hp.chunkSize * hp.actionDim, 'action shape matches')
    t.ok(actions.every(Number.isFinite), 'all actions are finite')
  } finally {
    await model.unload().catch(() => {})
  }
})
