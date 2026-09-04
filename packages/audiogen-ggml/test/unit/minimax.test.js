'use strict'

const test = require('brittle')
const os = require('bare-os')
const {
  AudioGen,
  ENGINE_ACESTEP,
  ENGINE_MINIMAX,
  ERR_CODES,
  MINIMAX_DEFAULT_MAX_FRAMES,
  detectEngineType
} = require('../../index.js')

function withPlatform(platform, action) {
  const originalPlatform = os.platform
  os.platform = () => platform
  try {
    return action()
  } finally {
    os.platform = originalPlatform
  }
}

function captureError(action) {
  try {
    action()
    return null
  } catch (error) {
    return error
  }
}

function createHarness(options = {}) {
  let received
  const gen = new AudioGen({
    engine: ENGINE_MINIMAX,
    files: { modelDir: '/models/minimax' },
    ...options
  })
  gen.addon = {
    runJob(data) {
      received = data
      gen._addonOutputCallback(null, null, { totalTimeMs: 0 }, null)
      return Promise.resolve(true)
    },
    cancel: () => Promise.resolve(),
    destroyInstance: () => Promise.resolve()
  }
  return { gen, received: () => received }
}

test('detectEngineType selects MiniMax from synth path', (t) => {
  t.is(
    detectEngineType({ lmModel: '/models/lm.gguf', synthModel: '/models/synth.gguf' }),
    ENGINE_MINIMAX
  )
  t.is(detectEngineType({ modelDir: '/models/acestep' }), ENGINE_ACESTEP)
  t.is(detectEngineType({}, ENGINE_MINIMAX), ENGINE_MINIMAX)
})

test('AudioGen rejects MiniMax on Android without affecting ACE-Step', (t) => {
  const error = withPlatform('android', () =>
    captureError(
      () =>
        new AudioGen({
          engine: ENGINE_MINIMAX,
          files: { modelDir: '/models/minimax' }
        })
    )
  )
  const acestep = withPlatform(
    'android',
    () => new AudioGen({ files: { modelDir: '/models/acestep' } })
  )

  t.is(error.code, ERR_CODES.INVALID_INPUT)
  t.is(acestep._engineType, ENGINE_ACESTEP)
})

test('AudioGen rejects MiniMax on iOS without affecting ACE-Step', (t) => {
  const error = withPlatform('ios', () =>
    captureError(
      () =>
        new AudioGen({
          engine: ENGINE_MINIMAX,
          files: { modelDir: '/models/minimax' }
        })
    )
  )
  const acestep = withPlatform(
    'ios',
    () => new AudioGen({ files: { modelDir: '/models/acestep' } })
  )

  t.is(error.code, ERR_CODES.INVALID_INPUT)
  t.is(acestep._engineType, ENGINE_ACESTEP)
})

test('AudioGen configures the MiniMax native engine', (t) => {
  const { gen } = createHarness({
    files: {
      lmModel: '/models/mm3-lm-q8.gguf',
      synthModel: '/models/mm3-synth-q8.gguf'
    },
    config: { threads: 6, inferenceSteps: 12, cfgScale: 1.8 }
  })

  t.is(gen._configuration.engineType, ENGINE_MINIMAX)
  t.is(gen._configuration.lmModelPath, '/models/mm3-lm-q8.gguf')
  t.is(gen._configuration.synthModelPath, '/models/mm3-synth-q8.gguf')
  t.is(gen._configuration.threads, 6)
  t.is(gen._configuration.useGPU, false)
})

test('AudioGen forwards MiniMax useGPU to the native engine', (t) => {
  const { gen } = createHarness({ config: { useGPU: true } })
  t.is(gen._configuration.useGPU, true)
})

test('AudioGen forwards MiniMax frame and flow controls', async (t) => {
  const { gen, received } = createHarness({
    config: { inferenceSteps: 8, cfgScale: 1.5 }
  })

  const response = await gen.run('warm piano', {
    duration: 2.5,
    seed: 7,
    lyrics: '[Instrumental]'
  })
  await response.await()

  const job = received()
  t.is(job.maxFrames, 63)
  t.is(job.inferenceSteps, 8)
  t.is(job.cfgScale, 1.5)
  t.is(job.seed, 7)
})

test('AudioGen lets MiniMax run controls override config defaults', async (t) => {
  const { gen, received } = createHarness({
    config: { inferenceSteps: 8, cfgScale: 1.5 }
  })

  const response = await gen.run('ambient strings', {
    maxFrames: 4,
    inferenceSteps: 2,
    cfgScale: 1.7
  })
  await response.await()

  const job = received()
  t.is(job.maxFrames, 4)
  t.is(job.inferenceSteps, 2)
  t.is(job.cfgScale, 1.7)
})

test('AudioGen uses the MiniMax default frame cap', async (t) => {
  const { gen, received } = createHarness()
  const response = await gen.run('short melody')
  await response.await()
  t.is(received().maxFrames, MINIMAX_DEFAULT_MAX_FRAMES)
})

test('AudioGen rejects unsupported MiniMax construction options', (t) => {
  t.exception(
    () =>
      new AudioGen({
        engine: ENGINE_MINIMAX,
        files: { modelDir: '/models/minimax' },
        config: { useGPU: 1 }
      }),
    /useGPU must be a boolean/
  )
  t.exception(
    () => new AudioGen({ engine: ENGINE_MINIMAX, files: { lmModel: '/models/lm.gguf' } }),
    /requires modelDir or both lmModel and synthModel/
  )
  t.exception(
    () =>
      new AudioGen({
        engine: ENGINE_MINIMAX,
        files: { modelDir: '/models/minimax', ditModel: '/models/dit.gguf' }
      }),
    /does not accept ACE-Step/
  )
})

test('AudioGen rejects unsupported MiniMax generation options', async (t) => {
  const { gen } = createHarness()
  await t.exception(() => gen.run('test', { bpm: 120 }), /MiniMax does not accept bpm/)
  await t.exception(
    () => gen.run('test', { augmentCaptionWithMetadata: true }),
    /MiniMax does not accept augmentCaptionWithMetadata/
  )
  await t.exception(() => gen.run('test', { track: 'guitar' }), /MiniMax does not accept track/)
  await t.exception(
    () => gen.run('test', { guidanceScale: 7 }),
    /MiniMax does not accept guidanceScale/
  )
  await t.exception(
    () => gen.run('test', { computeQualityScore: true }),
    /MiniMax does not accept computeQualityScore/
  )
  await t.exception(
    () => gen.run('test', { duration: 2, maxFrames: 50 }),
    /either maxFrames or duration/
  )
  await t.exception(() => gen.run('test', { maxFrames: 0 }), /maxFrames must be at least 1/)
  await t.exception(
    () => gen.run('test', { maxFrames: Number.MAX_SAFE_INTEGER + 1 }),
    /maxFrames must be a safe integer/
  )
  await t.exception(
    () => gen.run('test', { inferenceSteps: -1 }),
    /inferenceSteps must be between 0 and 1000/
  )
  await t.exception(
    () => gen.run('test', { inferenceSteps: 1001 }),
    /inferenceSteps must be between 0 and 1000/
  )
  await t.exception(
    () => gen.run('test', { cfgScale: Number.MAX_VALUE }),
    /cfgScale must be 0 or a positive float32 value/
  )
  await t.exception(
    () => gen.run('test', { cfgScale: 1e-100 }),
    /cfgScale must be 0 or a positive float32 value/
  )
})

test('AudioGen rejects ACE-Step editing for MiniMax', (t) => {
  const { gen } = createHarness()
  t.exception(
    () =>
      gen.edit({
        pcm: new Int16Array(2),
        sampleRate: 44100,
        channels: 2
      }),
    /MiniMax-Music3 does not support audio editing/
  )
})

test('AudioGen rejects out-of-range MiniMax constructor controls', (t) => {
  t.exception(
    () =>
      createHarness({
        config: { inferenceSteps: 1001 }
      }),
    /inferenceSteps must be between 0 and 1000/
  )
  t.exception(
    () =>
      createHarness({
        config: { cfgScale: -1 }
      }),
    /cfgScale must be 0 or a positive float32 value/
  )
  t.exception(
    () =>
      createHarness({
        config: { threads: Number.MAX_SAFE_INTEGER }
      }),
    /threads must be between 0 and 2147483647/
  )
})
