'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const { VlaModel, preprocessImage, padState } = require('../..')

test('integration: module exports expected surface', (t) => {
  t.is(typeof VlaModel, 'function')
  t.is(typeof preprocessImage, 'function')
  t.is(typeof padState, 'function')
})

test('integration: VlaModel rejects empty path', (t) => {
  let err1 = null
  try { const m = new VlaModel(''); m.destroy() } catch (e) { err1 = e }
  t.ok(err1 && /non-empty string/.test(err1.message))

  let err2 = null
  try { const m = new VlaModel(); m.destroy() } catch (e) { err2 = e }
  t.ok(err2 && /non-empty string/.test(err2.message))
})

test('integration: VlaModel rejects missing GGUF file', (t) => {
  let err = null
  try { const m = new VlaModel('/definitely/does/not/exist.gguf'); m.destroy() } catch (e) { err = e }
  t.ok(err, 'expected an error for missing GGUF')
})

// End-to-end smoke test — skipped unless QVAC_VLA_MODEL points at a real
// SmolVLA GGUF. Run locally with:
//   QVAC_VLA_MODEL=/path/to/smolvla-libero.gguf npm run test:integration
test('integration: end-to-end inference runs (needs GGUF)', (t) => {
  const modelPath = process.env.QVAC_VLA_MODEL
  if (!modelPath || !fs.existsSync(modelPath)) {
    t.comment(`skipping: set QVAC_VLA_MODEL to a valid GGUF (got "${modelPath ?? ''}")`)
    t.pass()
    return
  }

  const model = new VlaModel(path.resolve(modelPath))
  t.teardown(() => model.destroy())

  const hp = model.hparams
  t.ok(hp.chunkSize > 0)
  t.ok(hp.actionDim > 0)

  const size = hp.visionImageSize
  const dummy = new Uint8Array(size * size * 3).fill(128)
  const img = preprocessImage(dummy, size, size, { size })

  const tokens = new Int32Array(hp.tokenizerMaxLength)
  const mask = new Uint8Array(hp.tokenizerMaxLength)
  tokens[0] = 1 // BOS-like token
  mask[0] = 1

  const state = padState([0, 0, 0, 0, 0, 0], hp.maxStateDim)
  const noise = new Float32Array(hp.chunkSize * hp.maxActionDim)
  for (let i = 0; i < noise.length; i++) noise[i] = 0

  const actions = model.run({
    images: [img, img],
    imgWidth: size,
    imgHeight: size,
    state,
    tokens,
    mask,
    noise
  })

  t.ok(actions instanceof Float32Array)
  t.is(actions.length, hp.chunkSize * hp.actionDim)
})
