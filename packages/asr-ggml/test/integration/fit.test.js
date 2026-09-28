'use strict'

const test = require('brittle')

const ASRGgml = require('../../index.js')
const { ensureWhisperModel, ensureVADModel, getTestPaths, getBackendsDir } = require('./helpers.js')

const TEST_TIMEOUT_MS = 900000
const { modelPath, vadModelPath } = getTestPaths()
const backendsDir = getBackendsDir()

function sumRows(fit) {
  return fit.deviceBytes + fit.hostBytes
}

test('a whisper projection is internally consistent', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  await ensureWhisperModel(modelPath)

  const fit = ASRGgml.assessFit({ engine: 'whisper', modelPath, backendsDir })

  t.comment(`status=${fit.status} reason=${fit.reason} device=${fit.deviceName}`)
  t.ok(fit.status === 'fits' || fit.status === 'does-not-fit', 'a verdict, not an error')
  t.ok(fit.deviceName.length > 0, 'a device was resolved')
  t.ok(fit.deviceTotalBytes > 0, 'the device reported its capacity')
  t.ok(fit.deviceFreeBytes <= fit.deviceTotalBytes, 'free never exceeds total')
  t.ok(fit.weightsBytes > 0, 'the weights were measured')
  t.ok(sumRows(fit) >= fit.weightsBytes, 'the weights are part of the demand')
  t.is(fit.modelType.length > 0, true, 'the model type was read')
})

test('the backends root resolves a device', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  await ensureWhisperModel(modelPath)

  const fit = ASRGgml.assessFit({ engine: 'whisper', modelPath, backendsDir })

  // The registry is built once per process, so a root that resolves to nothing
  // would leave every later load in this process without a device too.
  t.not(fit.reason, 'no-backend-device', 'the prebuilds root reached the backends')
})

test('a longer transcribe costs more', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  await ensureWhisperModel(modelPath)

  const short = ASRGgml.assessFit({
    engine: 'whisper',
    modelPath,
    backendsDir,
    audioSeconds: 30
  })
  const long = ASRGgml.assessFit({
    engine: 'whisper',
    modelPath,
    backendsDir,
    audioSeconds: 600
  })

  if (short.status === 'error' || long.status === 'error') {
    t.pass('this runner could not project the model')
    return
  }
  t.ok(sumRows(long) >= sumRows(short), 'the longer window never costs less')
})

test('a VAD model is added to the projection', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  await ensureWhisperModel(modelPath)
  const vad = await ensureVADModel(vadModelPath)
  if (!vad || vad.success === false) {
    t.pass('no VAD model on this runner')
    return
  }

  const bare = ASRGgml.assessFit({ engine: 'whisper', modelPath, backendsDir })
  const withVad = ASRGgml.assessFit({
    engine: 'whisper',
    modelPath,
    backendsDir,
    vadModelPath
  })

  if (bare.status === 'error' || withVad.status === 'error') {
    t.pass('this runner could not project the model')
    return
  }
  t.is(bare.vadBytes, 0, 'no VAD model was named')
  t.ok(withVad.vadBytes > 0, 'the VAD model was measured')
})

test('a model that cannot be read is an outcome, not a throw', (t) => {
  const fit = ASRGgml.assessFit({ engine: 'whisper', modelPath: '/nonexistent/model.bin' })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
})

test('an unrecognised engine is refused', (t) => {
  t.exception(
    () => ASRGgml.assessFit({ engine: 'nonexistent', modelPath: '/models/model.gguf' }),
    /engine/
  )
})

test('a count that is not a count is refused', (t) => {
  t.exception(
    () =>
      ASRGgml.assessFit({
        engine: 'whisper',
        modelPath: '/models/model.bin',
        decoders: -1
      }),
    /non-negative count/
  )
})
