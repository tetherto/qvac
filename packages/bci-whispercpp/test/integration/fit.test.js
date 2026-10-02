'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')

const { assessFit } = require('../../index.js')
const { getModelPath } = require('./helpers.js')

const MODEL_PATH =
  (os.hasEnv('WHISPER_MODEL_PATH') ? os.getEnv('WHISPER_MODEL_PATH') : null) ||
  getModelPath('ggml-bci-windowed.bin')

const EMBEDDER_PATH = path.join(path.dirname(MODEL_PATH), 'bci-embedder.bin')

const hasModel = fs.existsSync(MODEL_PATH)
const requireModel = os.hasEnv('BCI_REQUIRE_MODEL') && os.getEnv('BCI_REQUIRE_MODEL') === '1'

if (requireModel && !hasModel) {
  throw new Error(
    'BCI_REQUIRE_MODEL=1 but model file was not found at ' +
      MODEL_PATH +
      '. Run `npm run download-models` or set WHISPER_MODEL_PATH.'
  )
}

function skipWithoutModel(t) {
  if (hasModel) return false
  t.pass('no BCI model on this runner')
  return true
}

test('a projection is internally consistent', (t) => {
  if (skipWithoutModel(t)) return

  const fit = assessFit({ modelPath: MODEL_PATH })

  t.comment(`status=${fit.status} reason=${fit.reason} device=${fit.deviceName}`)
  t.ok(fit.status === 'fits' || fit.status === 'does-not-fit', 'a verdict, not an error')
  t.ok(fit.deviceTotalBytes > 0, 'the device reported its capacity')
  t.ok(fit.deviceFreeBytes <= fit.deviceTotalBytes, 'free never exceeds total')
  t.ok(fit.weightsBytes > 0, 'the weights were measured')
  t.ok(
    fit.deviceBytes >= fit.weightsBytes || fit.hostBytes >= fit.weightsBytes,
    'the weights are part of the demand'
  )
})

test('the embedder is sized from disk and left out of the projection', (t) => {
  if (skipWithoutModel(t)) return
  if (!fs.existsSync(EMBEDDER_PATH)) {
    t.pass('no embedder on this runner')
    return
  }

  const bare = assessFit({ modelPath: MODEL_PATH })
  const withEmbedder = assessFit({ modelPath: MODEL_PATH, embedderPath: EMBEDDER_PATH })

  t.is(bare.embedderFileBytes, 0, 'no embedder was named')
  t.is(
    withEmbedder.embedderFileBytes,
    fs.statSync(EMBEDDER_PATH).size,
    'the embedder is reported at its size on disk'
  )
  t.is(withEmbedder.deviceBytes, bare.deviceBytes, 'the embedder is outside the device demand')
  t.is(withEmbedder.hostBytes, bare.hostBytes, 'and outside the host demand')
})

test('an embedder path that does not exist reports zero', (t) => {
  if (skipWithoutModel(t)) return

  const fit = assessFit({ modelPath: MODEL_PATH, embedderPath: '/nonexistent/embedder.bin' })

  t.is(fit.embedderFileBytes, 0)
})

test('a model that cannot be read is an outcome, not a throw', (t) => {
  const fit = assessFit({ modelPath: '/nonexistent/model.bin' })

  t.is(fit.status, 'error')
  t.ok(fit.reason.length > 0, 'the engine gave a reason')
})

test('every projected field is present on an unreadable model', (t) => {
  const fit = assessFit({ modelPath: '/nonexistent/model.bin' })

  for (const field of [
    'deviceFreeBytes',
    'deviceTotalBytes',
    'deviceBytes',
    'weightsBytes',
    'kvBytes',
    'computeBytes',
    'hostOverflowBytes',
    'hostBytes',
    'embedderFileBytes'
  ]) {
    t.is(typeof fit[field], 'number', `${field} is a number`)
  }
})

test('a count that is not a count is refused', (t) => {
  t.exception(
    () => assessFit({ modelPath: '/models/model.bin', decoders: -1 }),
    /non-negative count/
  )
})
