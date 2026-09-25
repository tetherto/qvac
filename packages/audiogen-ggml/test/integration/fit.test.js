'use strict'

const path = require('bare-path')
const test = require('brittle')

const { assessFit } = require('../../index.js')
const { ensureAudiogenModels, getBaseDir } = require('../utils/downloadModel')

const TEST_TIMEOUT_MS = 1800000
const VARIANT = 'turbo-q4'

function modelsDir() {
  return path.join(getBaseDir(), 'models')
}

async function stagedModels(t) {
  const download = await ensureAudiogenModels({ targetDir: modelsDir(), variant: VARIANT })
  if (!download.success) {
    t.pass('ACE-Step models unavailable on this runner')
    return null
  }
  return modelsDir()
}

test('a projection is internally consistent', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const dir = await stagedModels(t)
  if (dir === null) return

  const fit = assessFit({ modelsDir: dir, durationSeconds: 10 })

  t.comment(`status=${fit.status} reason=${fit.reason} device=${fit.deviceName}`)
  t.ok(fit.status === 'fits' || fit.status === 'does-not-fit', 'a verdict, not an error')
  t.ok(fit.deviceTotalBytes > 0, 'the device reported its capacity')
  t.ok(fit.deviceFreeBytes <= fit.deviceTotalBytes, 'device free never exceeds installed')
  t.ok(fit.hostTotalBytes > 0, 'the host reported its capacity')
  t.ok(fit.hostFreeBytes <= fit.hostTotalBytes, 'host free never exceeds installed')
  t.ok(fit.deviceBytes > 0, 'the pipeline peak was measured')
  t.ok(fit.modelName.length > 0, 'the model set was identified')
})

test('the stages account for the peak', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const dir = await stagedModels(t)
  if (dir === null) return

  const fit = assessFit({ modelsDir: dir, durationSeconds: 10 })
  if (fit.status === 'error') {
    t.pass('this runner could not project the model set')
    return
  }

  t.ok(fit.stages.length > 0, 'the pipeline was broken down')
  for (const stage of fit.stages) {
    t.ok(stage.name.length > 0, `${stage.name}: named`)
    t.ok(stage.weightsBytes >= 0, `${stage.name}: weights measured`)
  }
  const peakStage = Math.max(...fit.stages.map((stage) => stage.weightsBytes + stage.computeBytes))
  t.ok(fit.deviceBytes >= peakStage || fit.hostBytes >= peakStage, 'the peak covers a stage')
})

test('a longer generation costs no less', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const dir = await stagedModels(t)
  if (dir === null) return

  const short = assessFit({ modelsDir: dir, durationSeconds: 5 })
  const long = assessFit({ modelsDir: dir, durationSeconds: 60 })
  if (short.status === 'error' || long.status === 'error') {
    t.pass('this runner could not project the model set')
    return
  }

  t.ok(long.deviceBytes + long.hostBytes >= short.deviceBytes + short.hostBytes)
})

test('an engine with no fitter is an outcome, not a throw', (t) => {
  const fit = assessFit({ engine: 'minimax', modelsDir: '/models/minimax' })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'unsupported-engine')
  t.is(fit.modelName, 'minimax')
  t.alike(fit.stages, [])
})

test('a model set that cannot be read is an outcome, not a throw', (t) => {
  const fit = assessFit({ ditPath: '/nonexistent/dit.gguf' })

  t.is(fit.status, 'error')
  t.ok(fit.reason.length > 0, 'the engine gave a reason')
})

test('a count that is not a count is refused', (t) => {
  t.exception(
    () => assessFit({ modelsDir: '/models/ace-step', durationSeconds: -1 }),
    /non-negative count/
  )
})
