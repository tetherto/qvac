'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const TTSGgml = require('../../index.js')
const { TTSInterface } = require('../../tts.js')
const MockedBinding = require('../mock/MockedBinding.js')
const process = require('bare-process')

global.process = process

// The cross-engine emotion/pace surface. Three things are pinned here:
//   1. the JS vocabulary mirror does not drift from the tts-cpp source of truth
//   2. both emotion-capable families accept the same value in the same three
//      places (constructor / reload / per call) -- the actual unification claim
//   3. a channel an engine cannot change per call is rejected, not dropped, and
//      a rejected reload leaves the instance as it was

const ENGINE_FILES = {
  parler: { parlerModel: './models/parler-indic-q8_0.gguf' },
  cosyvoice3: { cosyvoiceModelDir: './models/cosyvoice3' },
  supertonic: { supertonicModel: './models/supertonic2.gguf' },
  chatterbox: { t3Model: './models/t3.gguf', s3genModel: './models/s3gen.gguf' },
  audio8: { audio8Lm: './models/audio8-lm.gguf' }
}

/** MockedBinding that records every runJob payload (per-call field checks). */
class RecordingBinding extends MockedBinding {
  constructor(opts) {
    super(opts)
    this.jobs = []
  }

  runJob(handle, data) {
    this.jobs.push(data)
    return super.runJob(handle, data)
  }
}

function createModel(engine, extra = {}, binding) {
  const model = new TTSGgml({
    engine,
    files: ENGINE_FILES[engine],
    config: { language: 'en', useGPU: false },
    ...extra
  })
  model._createAddon = (configurationParams, outputCb) =>
    new TTSInterface(binding || new MockedBinding(), configurationParams, outputCb)
  return model
}

// --- 1. mirror pin --------------------------------------------------------

// tts-cpp owns the vocabulary in engines/tts/src/voice_controls.cpp. Parsing
// that table here keeps the JS copy honest without a codegen step. The path is
// resolved from an env var so the test is skipped, not failed, in a checkout
// that has no sibling tts-cpp source tree (published tarballs, CI lanes that
// only unpack the port).
function readNativeTable(source, tableName) {
  const start = source.indexOf(`k_${tableName}[] = {`)
  if (start === -1) return null
  const end = source.indexOf('};', start)
  const body = source.slice(start, end)
  return [...body.matchAll(/\{\s*"([^"]+)"/g)].map((match) => match[1])
}

function nativeVoiceControlsSource() {
  const override = process.env.TTS_CPP_SOURCE_DIR
  const candidates = [
    override && path.join(override, 'src/voice_controls.cpp'),
    path.join(
      __dirname,
      '../../../../../qvac-fabric-speech.cpp/engines/tts/src/voice_controls.cpp'
    )
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      return fs.readFileSync(candidate, 'utf8')
    } catch {}
  }
  return null
}

test('voice controls: the JS vocabulary mirrors the tts-cpp source of truth', (t) => {
  const source = nativeVoiceControlsSource()
  if (!source) {
    t.pass('tts-cpp source tree not available; mirror pin skipped')
    return
  }
  const nativeEmotions = readNativeTable(source, 'emotions')
  const nativePaces = readNativeTable(source, 'paces')
  t.ok(nativeEmotions && nativeEmotions.length > 0, 'parsed the native emotion table')
  t.ok(nativePaces && nativePaces.length > 0, 'parsed the native pace table')

  // Every canonical value must be accepted by at least one engine, and the
  // union of what the JS layer accepts must equal the native vocabulary.
  for (const emotion of nativeEmotions) {
    t.execution(
      () => createModel('parler', { emotion }),
      `parler accepts the canonical emotion "${emotion}"`
    )
  }
  for (const pace of nativePaces) {
    t.execution(
      () => createModel('parler', { pace }),
      `parler accepts the canonical pace "${pace}"`
    )
  }
  t.exception(
    () => createModel('parler', { emotion: 'not-a-canonical-emotion' }),
    /invalid emotion/,
    'a value outside the native table is rejected'
  )
})

// --- 2. per-engine support matrix ----------------------------------------

test('voice controls: each engine declares what it supports', (t) => {
  t.execution(() => createModel('parler', { emotion: 'surprise' }), 'parler: all 12')
  t.execution(() => createModel('cosyvoice3', { emotion: 'sad' }), 'cosyvoice3: trained subset')

  t.exception(
    () => createModel('cosyvoice3', { emotion: 'surprise' }),
    /not supported by the cosyvoice3 engine/,
    'cosyvoice3 rejects an untrained emotion, naming its own set'
  )
  t.exception(
    () => createModel('supertonic', { emotion: 'happy' }),
    /does not support `emotion`/,
    'supertonic reports it has no emotion control'
  )
  t.exception(
    () => createModel('chatterbox', { emotion: 'happy' }),
    /does not support `emotion`/,
    'chatterbox reports it has no emotion control'
  )
  t.exception(
    () => createModel('audio8', { emotion: 'happy' }),
    /does not support `emotion`/,
    'audio8 reports it has no emotion control'
  )

  t.execution(() => createModel('supertonic', { pace: 'slow' }), 'supertonic takes pace')
  t.exception(
    () => createModel('chatterbox', { pace: 'slow' }),
    /does not support `pace`.*speed/s,
    'chatterbox points at its exact multiplier instead'
  )
  t.exception(
    () => createModel('audio8', { pace: 'slow' }),
    /does not support `pace`/,
    'audio8 has no rate control at all'
  )
})

test('voice controls: pace reaches each engine as the canonical step', (t) => {
  t.is(createModel('parler', { pace: 'fast' })._buildTtsParams().pace, 'fast')
  t.is(createModel('cosyvoice3', { pace: 'fast' })._buildTtsParams().pace, 'fast')
  t.is(createModel('supertonic', { pace: 'fast' })._buildTtsParams().pace, 'fast')
  // `speed` is a separate exact multiplier and must be untouched by this work.
  t.is(createModel('supertonic', { speed: 1.2 })._buildTtsParams().speed, 1.2)
  t.absent(createModel('supertonic', { speed: 1.2 })._buildTtsParams().pace)
})

// --- 3. channel parity: the actual unification claim ----------------------

for (const engine of ['parler', 'cosyvoice3']) {
  test(`voice controls: ${engine} accepts emotion in all three places`, async (t) => {
    const constructed = createModel(engine, { emotion: 'happy' })
    t.is(
      constructed._buildTtsParams().emotion,
      'happy',
      'constructor emotion reaches the native params'
    )

    const reloaded = createModel(engine, { emotion: 'happy' })
    await reloaded.load()
    await reloaded.reload({ emotion: 'sad' })
    t.is(reloaded._emotion, 'sad', 'reload() updates the emotion')
    await reloaded.destroy()

    const binding = new RecordingBinding()
    const perCall = createModel(engine, {}, binding)
    await perCall.load()
    await perCall.run({ input: 'hello', emotion: 'sad' })
    t.is(binding.jobs.length, 1, 'one job ran')
    t.is(binding.jobs[0].emotion, 'sad', 'per-call emotion rides on the job data')
    await perCall.destroy()
  })
}

test('voice controls: per-call emotion is rejected where the engine has none', async (t) => {
  const model = createModel('supertonic')
  await model.load()
  await t.exception(
    model.run({ input: 'hello', emotion: 'happy' }),
    /does not support `emotion`/,
    'supertonic rejects a per-call emotion'
  )
  await model.destroy()
})

for (const engine of ['parler', 'cosyvoice3']) {
  test(`voice controls: ${engine} carries a per-call pace to the job`, async (t) => {
    const binding = new RecordingBinding()
    const model = createModel(engine, {}, binding)
    await model.load()
    await model.run({ input: 'hello', pace: 'slow' })
    t.is(binding.jobs.length, 1, 'one job ran')
    t.is(binding.jobs[0].pace, 'slow', 'per-call pace rides on the job data')
    await model.destroy()
  })
}

// --- 4. channels the engine cannot change per call ------------------------

// Supertonic conditions pace through EngineOptions when the engine is built,
// and tts-cpp gives synthesize() no per-call surface for it, so accepting one
// here would drop it on the way to the engine.
test('voice controls: supertonic rejects a per-call pace', async (t) => {
  const binding = new RecordingBinding()
  const model = createModel('supertonic', {}, binding)
  await model.load()

  await t.exception(
    model.run({ input: 'hello', pace: 'fast' }),
    /cannot change per call.*reload/s,
    'run() names the constructor and reload() instead of dropping it'
  )
  await t.exception(
    model.run({ input: 'hello', streamOutput: true, pace: 'fast' }),
    /cannot change per call/,
    'streamOutput takes the same path'
  )
  await t.exception(
    model.runStream('hello', { pace: 'fast' }),
    /cannot change per call/,
    'runStream() rejects it too'
  )
  await t.exception(
    model.runStreaming((async function* () {})(), { pace: 'fast' }),
    /cannot change per call/,
    'runStreaming() rejects it too'
  )
  t.is(binding.jobs.length, 0, 'no job was dispatched with a dropped pace')
  await model.destroy()
})

test('voice controls: supertonic still takes pace where it works', async (t) => {
  const constructed = createModel('supertonic', { pace: 'slow' })
  t.is(constructed._buildTtsParams().pace, 'slow', 'constructor pace reaches the native params')

  const reloaded = createModel('supertonic', { pace: 'slow' })
  await reloaded.load()
  await reloaded.reload({ pace: 'fast' })
  t.is(reloaded._pace, 'fast', 'reload() updates the pace')
  await reloaded.destroy()
})

// --- 5. a rejected reload leaves the instance untouched -------------------

test('voice controls: a rejected reload does not retain the rejected value', async (t) => {
  const model = createModel('cosyvoice3', { emotion: 'happy' })
  await model.load()

  await t.exception(
    model.reload({ pace: 'fast' }),
    /reload: conflicting conditioning controls/,
    'the conflict is reported against reload, not the constructor'
  )
  t.is(model._emotion, 'happy', 'the accepted emotion survives')
  t.absent(model._pace, 'the rejected pace is not retained')

  // Without the rollback this reload would be validated against pace="fast"
  // and fail, even though the caller never got that value accepted.
  await t.execution(
    model.reload({ emotion: 'sad' }),
    'a later partial reload is validated against the live state'
  )
  t.is(model._emotion, 'sad', 'the later reload applied')
  await model.destroy()
})

test('voice controls: a rejected parler reload does not retain the template field', async (t) => {
  const model = createModel('parler', { description: 'A calm, clear voice.' })
  await model.load()

  await t.exception(
    model.reload({ voice: 'Rohit' }),
    /mutually exclusive/,
    'description plus a template field is rejected'
  )
  t.absent(model._voice, 'the rejected voice is not retained')
  t.is(
    model._buildTtsParams().description,
    'A calm, clear voice.',
    'the instance still builds the configuration it had'
  )
  await model.destroy()
})
