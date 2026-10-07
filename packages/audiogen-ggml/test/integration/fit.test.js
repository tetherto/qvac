'use strict'

const os = require('bare-os')
const path = require('bare-path')
const proc = require('bare-process')
const test = require('brittle')

const { assessFit } = require('../../index.js')
const { ensureAudiogenModels, getBaseDir } = require('../utils/downloadModel')

const TEST_TIMEOUT_MS = 1800000
const VARIANT = 'turbo-q4'
const MINIMAX_STAGES = ['lm', 'depth', 'cond', 'dit', 'vocoder']
const MISSING_MINIMAX_LM = '/nonexistent/mm3-lm-q8_0.gguf'
const MISSING_MINIMAX_SYNTH = '/nonexistent/mm3-synth-q8_0.gguf'
const MINIMAX_MAX_PROMPT_TOKENS = 5000
const MINIMAX_CONTEXT_LENGTH = 10240
const MINIMAX_SHORT_PROMPT_TOKENS = 64
const OVERFLOWING_DURATION_SECONDS = 1e20
const minimaxModelsDir = proc.env.AUDIOGEN_TEST_MINIMAX_MODELS_DIR
const isMobile = os.platform() === 'android' || os.platform() === 'ios'

function modelsDir() {
  return path.join(getBaseDir(), 'models')
}

function minimaxFit(request) {
  return assessFit({ engine: 'minimax', modelsDir: minimaxModelsDir, device: 'cpu', ...request })
}

function lmStage(fit) {
  return fit.stages.find((stage) => stage.name === 'lm')
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
  const fit = assessFit({ engine: 'stable-audio', modelsDir: '/models/stable-audio' })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'unsupported-engine')
  t.is(fit.modelName, 'stable-audio')
  t.alike(fit.stages, [])
})

test('a MiniMax pair that cannot be read is an outcome, not a throw', (t) => {
  const fit = assessFit({
    engine: 'minimax',
    lmPath: MISSING_MINIMAX_LM,
    synthPath: MISSING_MINIMAX_SYNTH
  })

  t.is(fit.status, 'error')
  t.is(fit.reason, isMobile ? 'unsupported-engine' : 'model-unreadable')
})

test('MiniMax takes a duration or a frame cap, not both', { skip: isMobile }, (t) => {
  t.exception(
    () =>
      assessFit({
        engine: 'minimax',
        modelsDir: '/models/minimax',
        durationSeconds: 10,
        maxFrames: 250
      }),
    /not both/
  )
})

test('a MiniMax frame cap that is not a whole count is refused', { skip: isMobile }, (t) => {
  t.exception(
    () => assessFit({ engine: 'minimax', modelsDir: '/models/minimax', maxFrames: 2.5 }),
    /safe integer/
  )
})

test('a MiniMax duration too long to count in frames is refused', { skip: isMobile }, (t) => {
  t.exception(
    () =>
      assessFit({
        engine: 'minimax',
        modelsDir: '/models/minimax',
        durationSeconds: OVERFLOWING_DURATION_SECONDS
      }),
    /maxFrames derived from durationSeconds must be a safe integer/
  )
})

test(
  'a MiniMax projection covers its stages',
  { timeout: TEST_TIMEOUT_MS, skip: !minimaxModelsDir || isMobile },
  (t) => {
    const fit = minimaxFit({ maxFrames: 300 })

    t.comment(`status=${fit.status} reason=${fit.reason} device=${fit.deviceName}`)
    t.ok(fit.status === 'fits' || fit.status === 'does-not-fit', 'a verdict, not an error')
    t.ok(fit.deviceIsCpu, "device: 'cpu' projects the CPU")
    t.alike(
      fit.stages.map((stage) => stage.name),
      MINIMAX_STAGES
    )
    t.ok(fit.stagesResident, 'MiniMax keeps its stages resident')
    const resident = fit.stages.reduce(
      (total, stage) => total + stage.weightsBytes + stage.stateBytes + stage.computeBytes,
      0
    )
    t.ok(fit.deviceBytes >= resident, 'the peak covers every resident stage')
  }
)

test(
  'a longer MiniMax generation costs more',
  { timeout: TEST_TIMEOUT_MS, skip: !minimaxModelsDir || isMobile },
  (t) => {
    const short = minimaxFit({ durationSeconds: 10 })
    const long = minimaxFit({ durationSeconds: 120 })

    t.ok(long.deviceBytes > short.deviceBytes, 'the LM cache grows with the frames')
    t.ok(long.hostBytes > short.hostBytes, 'the waveform grows with the frames')
  }
)

test(
  'a MiniMax prompt override reaches the LM projection',
  { timeout: TEST_TIMEOUT_MS, skip: !minimaxModelsDir || isMobile },
  (t) => {
    const short = lmStage(minimaxFit({ promptTokens: MINIMAX_SHORT_PROMPT_TOKENS }))
    const long = lmStage(minimaxFit({ promptTokens: MINIMAX_MAX_PROMPT_TOKENS }))

    t.ok(long.stateBytes > short.stateBytes, 'the LM cache grows with the prompt')
    t.ok(long.computeBytes > short.computeBytes, 'the prefill graph grows with the prompt')
  }
)

test(
  'a MiniMax prompt over the checkpoint limit is too large',
  { timeout: TEST_TIMEOUT_MS, skip: !minimaxModelsDir || isMobile },
  (t) => {
    const fit = minimaxFit({ promptTokens: MINIMAX_MAX_PROMPT_TOKENS + 1 })

    t.is(fit.status, 'error')
    t.is(fit.reason, 'workload-too-large')
  }
)

test(
  'a MiniMax prompt that leaves too little context for the frames is too large',
  { timeout: TEST_TIMEOUT_MS, skip: !minimaxModelsDir || isMobile },
  (t) => {
    const framesLeft = MINIMAX_CONTEXT_LENGTH - MINIMAX_MAX_PROMPT_TOKENS
    const filled = minimaxFit({ promptTokens: MINIMAX_MAX_PROMPT_TOKENS, maxFrames: framesLeft })
    const overfilled = minimaxFit({
      promptTokens: MINIMAX_MAX_PROMPT_TOKENS,
      maxFrames: framesLeft + 1
    })

    t.not(filled.status, 'error', 'a prompt and frames that fill the context exactly project')
    t.is(overfilled.status, 'error')
    t.is(overfilled.reason, 'workload-too-large')
  }
)

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
