'use strict'

const test = require('brittle')
const { AudioGen, ENGINE_MINIMAX } = require('../../index.js')

const UNDERSTAND_PAYLOAD = {
  caption: 'a lively salsa with brass and congas',
  bpm: 96,
  duration: 4,
  keyscale: 'A minor',
  timesignature: '4/4',
  vocalLanguage: 'es',
  audioCodes: new Int32Array([12095, 63487, 12741])
}

function stereoPcm(samples, fill = 0.1) {
  const pcm = new Float32Array(samples)
  pcm.fill(fill)
  return pcm
}

function createUnderstandHarness(payload = UNDERSTAND_PAYLOAD) {
  let received
  const gen = new AudioGen({})
  gen.addon = {
    runJob(data) {
      received = data
      if (data.type === 'understand') {
        gen._addonOutputCallback(null, null, payload, null)
      }
      gen._addonOutputCallback(null, null, { totalTimeMs: 1 }, null)
      return Promise.resolve(true)
    },
    cancel: () => Promise.resolve(),
    destroyInstance: () => Promise.resolve()
  }
  return { gen, received: () => received }
}

test('AudioGen.understand validates its input', async (t) => {
  const { gen } = createUnderstandHarness()
  await t.exception(() => gen.understand([0.1, 0.2]), /understand audio must be a Float32Array/)
  await t.exception(() => gen.understand(new Float32Array(0)), /must not be empty/)
  await t.exception(
    () => gen.understand(new Float32Array(3)),
    /must be interleaved stereo \(even sample count\)/
  )
  await t.exception(
    () => gen.understand(stereoPcm(4, Number.NaN)),
    /understand audio must contain only finite samples/
  )
  await t.exception(() => gen.understand(stereoPcm(4), { seed: 1.5 }), /seed must be an integer/)
})

test('AudioGen.understand forwards the job and surfaces the description', async (t) => {
  const { gen, received } = createUnderstandHarness()
  const audio = stereoPcm(96)

  const response = await gen.understand(audio, {
    seed: 42,
    vocalLanguage: 'es',
    lmTemperature: 0.7,
    lmTopP: 0.8,
    lmTopK: 5
  })

  const items = []
  for await (const item of response.iterate()) items.push(item)
  const stats = await response.await()

  const job = received()
  t.is(job.type, 'understand')
  t.is(job.sourceAudio, audio)
  t.is(job.seed, 42)
  t.is(job.vocalLanguage, 'es')
  t.is(job.lmTemperature, 0.7)
  t.is(job.lmTopP, 0.8)
  t.is(job.lmTopK, 5)

  const understood = items.find((item) => item.understand)
  t.ok(understood, 'streamed the understand item')
  t.is(understood.understand.caption, UNDERSTAND_PAYLOAD.caption)
  t.is(understood.understand.bpm, UNDERSTAND_PAYLOAD.bpm)
  t.is(understood.understand.keyscale, UNDERSTAND_PAYLOAD.keyscale)
  t.is(understood.understand.timesignature, UNDERSTAND_PAYLOAD.timesignature)
  t.is(understood.understand.vocalLanguage, UNDERSTAND_PAYLOAD.vocalLanguage)
  t.is(understood.understand.audioCodes, UNDERSTAND_PAYLOAD.audioCodes)

  t.ok(stats.understand, 'stats repeat the description')
  t.is(stats.understand.caption, UNDERSTAND_PAYLOAD.caption)
  t.is(stats.understand.audioCodes, UNDERSTAND_PAYLOAD.audioCodes)
})

test('AudioGen.understand result does not leak into the next run stats', async (t) => {
  const { gen } = createUnderstandHarness()

  const understood = await gen.understand(stereoPcm(96))
  const understandStats = await understood.await()
  t.ok(understandStats.understand, 'understand stats carry the description')

  const generated = await gen.run('a plain caption')
  const generateStats = await generated.await()
  t.is(generateStats.understand, undefined, 'generation stats carry no stale description')
})

test('AudioGen.understand is rejected on MiniMax', async (t) => {
  const gen = new AudioGen({
    engine: ENGINE_MINIMAX,
    files: { modelDir: '/models/minimax' }
  })
  await t.exception(
    () => gen.understand(stereoPcm(4)),
    /MiniMax-Music3 does not support audio understanding/
  )
})
