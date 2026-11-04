'use strict'

const os = require('bare-os')
const path = require('bare-path')
const proc = require('bare-process')
const test = require('brittle')

const { assessFit } = require('../../index.js')
const { ensureAudiogenModels, getBaseDir } = require('../utils/downloadModel')

const TEST_TIMEOUT_MS = 1800000
const VARIANT = 'turbo-q4'
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

const isVerdict = (fit) => fit.status === 'fits' || fit.status === 'does-not-fit'
const totalUsed = (fit) => fit.devices.reduce((total, row) => total + row.usedBytes, 0)
const demand = (fit) => fit.devices.map((row) => [row.id, row.usedBytes])

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

  const fit = await assessFit({ modelsDir: dir, durationSeconds: 10 })

  t.comment(JSON.stringify(fit))
  t.ok(isVerdict(fit), 'a verdict')
  t.ok(fit.devices.length >= 1, 'at least the host row')
  t.is(fit.devices[fit.devices.length - 1].name, 'CPU', 'the host row is last')
  t.ok(fit.devices[fit.devices.length - 1].unified, 'the host row is unified')
  t.alike(fit.stats, {})
  for (const row of fit.devices) {
    t.ok(row.id.length > 0 && row.name.length > 0, `${row.name} is named`)
    t.ok(row.totalBytes > 0, `${row.name} reported its capacity`)
    t.ok(row.freeBytes <= row.totalBytes, `${row.name} free never exceeds installed`)
  }
  t.ok(totalUsed(fit) > 0, 'the pipeline peak was measured')
})

test('a CPU load is one host row', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const dir = await stagedModels(t)
  if (dir === null) return

  const fit = await assessFit({ modelsDir: dir, durationSeconds: 10, gpuLayers: 0 })
  const offloaded = await assessFit({ modelsDir: dir, durationSeconds: 10, gpuLayers: 99 })

  t.ok(isVerdict(fit), 'a verdict')
  t.is(fit.devices.length, 1, 'one row')
  t.ok(fit.devices[0].unified, 'the row is the host')
  t.ok(fit.devices[0].usedBytes > 0, 'the pipeline peak was measured')
  // The CPU pool is both the device and the host pool, so its peak is counted
  // once: the staged pipeline needs about what it needs offloaded, never twice.
  t.ok(
    fit.devices[0].usedBytes < 1.5 * totalUsed(offloaded),
    `the pool's peak counts once (${fit.devices[0].usedBytes} < 1.5 × ${totalUsed(offloaded)})`
  )
})

test('a longer generation costs no less', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const dir = await stagedModels(t)
  if (dir === null) return

  const short = await assessFit({ modelsDir: dir, durationSeconds: 5 })
  const long = await assessFit({ modelsDir: dir, durationSeconds: 60 })

  t.ok(totalUsed(long) >= totalUsed(short))
})

test('a fit keeps the event loop responsive', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const dir = await stagedModels(t)
  if (dir === null) return

  let pending = true
  let ticks = 0
  const timer = setInterval(() => {
    if (pending) ticks++
  }, 1)
  try {
    const fit = await assessFit({ modelsDir: dir, durationSeconds: 60 })
    pending = false
    t.ok(isVerdict(fit), 'a real native projection completed')
    t.ok(ticks > 0, 'timers ran before the fit settled')
    t.comment(`${ticks} timer ticks before completion`)
  } finally {
    pending = false
    clearInterval(timer)
  }
})

test(
  'concurrent fits keep their own requests and all settle',
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const dir = await stagedModels(t)
    if (dir === null) return

    const request = { modelsDir: dir, durationSeconds: 5 }
    const first = assessFit(request)
    request.durationSeconds = 60
    const second = assessFit(request)
    const missing = assessFit({ ditPath: '/nonexistent/dit.gguf' })
    const [short, long, unreadable] = await Promise.allSettled([first, second, missing])

    t.is(short.status, 'fulfilled', 'the first call was projected')
    t.is(long.status, 'fulfilled', 'the second call was projected')
    const alone = await assessFit({ modelsDir: dir, durationSeconds: 5 })
    t.alike(demand(short.value), demand(alone), 'the first call kept its original duration')
    t.ok(totalUsed(long.value) >= totalUsed(short.value), 'the second call kept its own duration')
    t.is(unreadable.status, 'rejected', 'a rejection does not strand the queued calls')
  }
)

test('an engine with no fitter rejects', async (t) => {
  await t.exception(
    assessFit({ engine: 'stable-audio', modelsDir: '/models/stable-audio' }),
    /stable-audio has no fitter/
  )
})

test('a MiniMax pair that cannot be read rejects', async (t) => {
  await t.exception(
    assessFit({
      engine: 'minimax',
      lmPath: MISSING_MINIMAX_LM,
      synthPath: MISSING_MINIMAX_SYNTH
    }),
    isMobile ? /minimax has no fitter/ : /model-unreadable/
  )
})

test('MiniMax takes a duration or a frame cap, not both', { skip: isMobile }, async (t) => {
  await t.exception(
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

test('a MiniMax frame cap that is not a whole count is refused', { skip: isMobile }, async (t) => {
  await t.exception(
    () => assessFit({ engine: 'minimax', modelsDir: '/models/minimax', maxFrames: 2.5 }),
    /safe integer/
  )
})

test('a MiniMax duration too long to count in frames is refused', { skip: isMobile }, async (t) => {
  await t.exception(
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
  'a MiniMax projection on the CPU is one host row',
  { timeout: TEST_TIMEOUT_MS, skip: !minimaxModelsDir || isMobile },
  async (t) => {
    const fit = await minimaxFit({ maxFrames: 300 })

    t.comment(JSON.stringify(fit))
    t.ok(isVerdict(fit), 'a verdict')
    t.is(fit.devices.length, 1, "device: 'cpu' projects the host alone")
    t.ok(fit.devices[0].unified, 'the row is the host')
    t.ok(fit.devices[0].usedBytes > 0, 'the resident stages were measured')
  }
)

test(
  'a longer MiniMax generation costs more',
  { timeout: TEST_TIMEOUT_MS, skip: !minimaxModelsDir || isMobile },
  async (t) => {
    const short = await minimaxFit({ durationSeconds: 10 })
    const long = await minimaxFit({ durationSeconds: 120 })

    t.ok(totalUsed(long) > totalUsed(short), 'the LM cache and the waveform grow with the frames')
  }
)

test(
  'a MiniMax prompt override reaches the LM projection',
  { timeout: TEST_TIMEOUT_MS, skip: !minimaxModelsDir || isMobile },
  async (t) => {
    const short = await minimaxFit({ promptTokens: MINIMAX_SHORT_PROMPT_TOKENS })
    const long = await minimaxFit({ promptTokens: MINIMAX_MAX_PROMPT_TOKENS })

    t.ok(totalUsed(long) > totalUsed(short), 'the LM cache and prefill grow with the prompt')
  }
)

test(
  'a MiniMax prompt over the checkpoint limit rejects',
  { timeout: TEST_TIMEOUT_MS, skip: !minimaxModelsDir || isMobile },
  async (t) => {
    await t.exception(
      minimaxFit({ promptTokens: MINIMAX_MAX_PROMPT_TOKENS + 1 }),
      /workload-too-large/
    )
  }
)

test(
  'a MiniMax prompt that leaves too little context for the frames rejects',
  { timeout: TEST_TIMEOUT_MS, skip: !minimaxModelsDir || isMobile },
  async (t) => {
    const framesLeft = MINIMAX_CONTEXT_LENGTH - MINIMAX_MAX_PROMPT_TOKENS
    const filled = await minimaxFit({
      promptTokens: MINIMAX_MAX_PROMPT_TOKENS,
      maxFrames: framesLeft
    })

    t.ok(isVerdict(filled), 'a prompt and frames that fill the context exactly project')
    await t.exception(
      minimaxFit({ promptTokens: MINIMAX_MAX_PROMPT_TOKENS, maxFrames: framesLeft + 1 }),
      /workload-too-large/
    )
  }
)

test('a model set that cannot be read rejects', async (t) => {
  await t.exception(assessFit({ ditPath: '/nonexistent/dit.gguf' }), /assessFit: /)
})

test('a count that is not a count is refused', async (t) => {
  await t.exception(
    () => assessFit({ modelsDir: '/models/ace-step', durationSeconds: -1 }),
    /non-negative count/
  )
})

test('a broken request rejects', async (t) => {
  let promise
  t.execution(() => {
    promise = assessFit({ modelsDir: '/models/ace-step', durationSeconds: -1 })
  }, 'the call itself returns')
  t.ok(promise instanceof Promise)
  await t.exception(promise, /non-negative count/)
})
