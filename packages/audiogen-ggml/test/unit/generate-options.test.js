'use strict'

const test = require('brittle')
const { AudioEditOperationType, AudioGen, RepaintMode } = require('../../index.js')

const EDIT_SAMPLE_RATE = 48000
const EDIT_CHANNELS = 2

function stereoSource(seconds, fill = 0) {
  const pcm = new Float32Array(EDIT_SAMPLE_RATE * seconds * EDIT_CHANNELS)
  if (fill !== 0) pcm.fill(fill)
  return { pcm, sampleRate: EDIT_SAMPLE_RATE, channels: EDIT_CHANNELS }
}

function createHarness(files) {
  let received
  const gen = new AudioGen(files ? { files } : {})
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

test('AudioGen.run forwards sampler, caption, DCW and frozen-code controls', async (t) => {
  const { gen, received } = createHarness()
  const audioCodes = new Int32Array([12095, 63487, 12741])

  const response = await gen.run('upbeat pop rock', {
    duration: 8,
    lmTemperature: 0.7,
    lmTopP: 0.8,
    lmTopK: 0,
    lmCfgScale: 1.5,
    lmPhase1: false,
    augmentCaptionWithMetadata: true,
    dcwEnabled: false,
    dcwScaler: 0,
    dcwHighScaler: 0,
    audioCodes
  })
  await response.await()

  const job = received()
  t.is(job.input, 'upbeat pop rock')
  t.is(job.duration, 8)
  t.is(job.lmTemperature, 0.7)
  t.is(job.lmTopP, 0.8)
  t.is(job.lmTopK, 0, 'zero top-k is preserved')
  t.is(job.lmCfgScale, 1.5)
  t.is(job.lmPhase1, false, 'false Phase 1 flag is preserved')
  t.is(job.augmentCaptionWithMetadata, true, 'caption augmentation flag is forwarded')
  t.is(job.dcwEnabled, false, 'false DCW flag is preserved')
  t.is(job.dcwScaler, 0, 'zero low-frequency scaler is preserved')
  t.is(job.dcwHighScaler, 0, 'zero high-frequency scaler is preserved')
  t.is(job.audioCodes, audioCodes, 'the Int32Array reaches the native job unchanged')
})

test('AudioGen.run rejects invalid sampler and DCW controls before native dispatch', async (t) => {
  const numericControls = ['lmTemperature', 'lmTopP', 'lmCfgScale', 'dcwScaler', 'dcwHighScaler']

  for (const name of numericControls) {
    const { gen } = createHarness()
    await t.exception(
      () => gen.run('test', { [name]: Number.POSITIVE_INFINITY }),
      new RegExp(`${name} must be a finite number`)
    )
  }

  {
    const { gen } = createHarness()
    await t.exception(() => gen.run('test', { lmTopK: 1.5 }), /lmTopK must be an integer/)
  }
  {
    const { gen } = createHarness()
    await t.exception(() => gen.run('test', { lmPhase1: 1 }), /lmPhase1 must be a boolean/)
  }
  {
    const { gen } = createHarness()
    await t.exception(
      () => gen.run('test', { augmentCaptionWithMetadata: 'yes' }),
      /augmentCaptionWithMetadata must be a boolean/
    )
  }
  {
    const { gen } = createHarness()
    await t.exception(() => gen.run('test', { dcwEnabled: 'yes' }), /dcwEnabled must be a boolean/)
  }
  {
    const { gen } = createHarness()
    await t.exception(
      () => gen.run('test', { audioCodes: new Uint32Array([1, 2, 3]) }),
      /audioCodes must be an Int32Array/
    )
  }
})

test('AudioGen.run rejects MiniMax-only controls for ACE-Step', async (t) => {
  const { gen } = createHarness()
  await t.exception(() => gen.run('test', { maxFrames: 10 }), /ACE-Step does not accept maxFrames/)
})

test('AudioGen.run forwards simpleMode with LM-written lyrics', async (t) => {
  const { gen, received } = createHarness()

  const response = await gen.run('a romantic modern salsa for a wedding', { simpleMode: true })
  await response.await()

  const job = received()
  t.is(job.simpleMode, true)
  t.is(job.lyrics, '')
})

test('AudioGen.run forwards simpleMode with the instrumental hint', async (t) => {
  const { gen, received } = createHarness()

  const response = await gen.run('a lo-fi instrumental groove', {
    simpleMode: true,
    lyrics: '[Instrumental]'
  })
  await response.await()

  const job = received()
  t.is(job.simpleMode, true)
  t.is(job.lyrics, '[Instrumental]')
})

test('AudioGen.run keeps the instrumental default without simpleMode', async (t) => {
  const { gen, received } = createHarness()

  const response = await gen.run('a plain caption')
  await response.await()

  const job = received()
  t.is(job.simpleMode, undefined)
  t.is(job.lyrics, '[Instrumental]')
})

test('AudioGen.run forwards normalizeLoudness', async (t) => {
  const { gen, received } = createHarness()

  const response = await gen.run('raw output please', { normalizeLoudness: false })
  await response.await()

  t.is(received().normalizeLoudness, false)
})

test('AudioGen.run rejects invalid simpleMode combinations', async (t) => {
  const sourceAudio = new Float32Array([0.3, -0.3])
  await rejectRunOptions(t, { simpleMode: 'yes' }, /simpleMode must be a boolean/)
  await rejectRunOptions(
    t,
    { simpleMode: true, taskType: 'cover-nofsq', sourceAudio },
    /simpleMode supports only taskType 'text2music'/
  )
  await rejectRunOptions(
    t,
    { simpleMode: true, audioCodes: new Int32Array([1, 2]) },
    /simpleMode cannot take pre-supplied audioCodes/
  )
  await rejectRunOptions(
    t,
    { simpleMode: true, lyrics: '[verse]\nwords' },
    /simpleMode lyrics must be omitted/
  )
  await rejectRunOptions(t, { simpleMode: true, lmPhase1: false }, /simpleMode requires lmPhase1/)
})

test('AudioGen.run validates and forwards computeQualityScore', async (t) => {
  const sourceAudio = new Float32Array([0.3, -0.3])
  await rejectRunOptions(t, { computeQualityScore: 'yes' }, /computeQualityScore must be a boolean/)
  await rejectRunOptions(
    t,
    { computeQualityScore: true, taskType: 'cover-nofsq', sourceAudio },
    /computeQualityScore requires taskType 'text2music'/
  )
  await rejectRunOptions(
    t,
    { computeQualityScore: true, taskType: 'lego', track: 'drums', sourceAudio },
    /computeQualityScore requires taskType 'text2music'/
  )

  const { gen, received } = createHarness()
  const response = await gen.run('scored take', { computeQualityScore: true })
  await response.await()
  t.is(received().computeQualityScore, true)
})

test('AudioGen.run forwards reference/source audio, taskType and cover strengths', async (t) => {
  const { gen, received } = createHarness()
  const referenceAudio = new Float32Array([0.1, -0.1, 0.2, -0.2])
  const sourceAudio = new Float32Array([0.3, -0.3, 0.4, -0.4, 0.5, -0.5])

  const response = await gen.run('salsa cover', {
    taskType: 'cover-nofsq',
    referenceAudio,
    sourceAudio,
    audioCoverStrength: 1,
    coverNoiseStrength: 0.25
  })
  await response.await()

  const job = received()
  t.is(job.taskType, 'cover-nofsq')
  t.is(job.referenceAudio, referenceAudio)
  t.is(job.sourceAudio, sourceAudio)
  t.is(job.audioCoverStrength, 1)
  t.is(job.coverNoiseStrength, 0.25)
})

test('AudioGen.run forwards partial audioCoverStrength for cover-nofsq', async (t) => {
  const { gen, received } = createHarness()
  const sourceAudio = new Float32Array([0.3, -0.3, 0.4, -0.4])

  const response = await gen.run('cover that diverges halfway', {
    taskType: 'cover-nofsq',
    sourceAudio,
    audioCoverStrength: 0.5
  })
  await response.await()

  const job = received()
  t.is(job.taskType, 'cover-nofsq')
  t.is(job.audioCoverStrength, 0.5)
})

test('AudioGen.run forwards text2music with optional referenceAudio only', async (t) => {
  const { gen, received } = createHarness()
  const referenceAudio = new Float32Array([0, 0, 0.5, -0.5])

  const response = await gen.run('timbre conditioned', {
    taskType: 'text2music',
    referenceAudio
  })
  await response.await()

  const job = received()
  t.is(job.taskType, 'text2music')
  t.is(job.referenceAudio, referenceAudio)
  t.is(job.sourceAudio, undefined)
})

async function rejectRunOptions(t, options, pattern) {
  const { gen } = createHarness()
  await t.exception(() => gen.run('test', options), pattern)
}

test('AudioGen.run rejects unsupported taskType', async (t) => {
  await rejectRunOptions(
    t,
    { taskType: 'repaint' },
    /taskType must be one of text2music\|cover\|cover-nofsq/
  )
})

test('AudioGen.run requires sourceAudio for cover-nofsq', async (t) => {
  await rejectRunOptions(
    t,
    { taskType: 'cover-nofsq' },
    /taskType 'cover-nofsq' requires sourceAudio/
  )
})

test('AudioGen.run rejects empty sourceAudio for cover', async (t) => {
  await rejectRunOptions(
    t,
    { taskType: 'cover', sourceAudio: new Float32Array(0) },
    /taskType 'cover' requires sourceAudio/
  )
})

test('AudioGen.run forwards lego track and guidance scale', async (t) => {
  const { gen, received } = createHarness()
  const sourceAudio = new Float32Array([0.3, -0.3, 0.4, -0.4])

  const response = await gen.run('guitar layer', {
    taskType: 'lego',
    track: 'guitar',
    guidanceScale: 7,
    sourceAudio
  })
  await response.await()

  const job = received()
  t.is(job.taskType, 'lego')
  t.is(job.track, 'guitar')
  t.is(job.guidanceScale, 7)
  t.is(job.sourceAudio, sourceAudio)
})

test('AudioGen.run requires sourceAudio for lego', async (t) => {
  await rejectRunOptions(
    t,
    { taskType: 'lego', track: 'guitar' },
    /taskType 'lego' requires sourceAudio/
  )
})

test('AudioGen.run requires a known lego track', async (t) => {
  const sourceAudio = new Float32Array([0.3, -0.3])
  await rejectRunOptions(t, { taskType: 'lego', sourceAudio }, /taskType 'lego' requires track/)
  await rejectRunOptions(
    t,
    { taskType: 'lego', track: 'accordion', sourceAudio },
    /taskType 'lego' requires track/
  )
})

test('AudioGen.run rejects non-finite guidanceScale', async (t) => {
  await rejectRunOptions(t, { guidanceScale: Number.NaN }, /guidanceScale/)
  await rejectRunOptions(t, { guidanceScale: Number.POSITIVE_INFINITY }, /guidanceScale/)
})

test('AudioGen.run rejects a negative guidanceScale', async (t) => {
  await rejectRunOptions(t, { guidanceScale: -2 }, /guidanceScale must be >= 0/)
})

test('AudioGen.run forwards an explicit zero guidanceScale', async (t) => {
  const { gen, received } = createHarness()

  const response = await gen.run('auto guidance', { guidanceScale: 0 })
  await response.await()

  t.is(received().guidanceScale, 0)
})

test('AudioGen.run rejects track outside the lego task', async (t) => {
  const sourceAudio = new Float32Array([0.3, -0.3])
  await rejectRunOptions(t, { track: 'guitar' }, /track is only valid with taskType 'lego'/)
  await rejectRunOptions(
    t,
    { taskType: 'cover-nofsq', track: 'guitar', sourceAudio },
    /track is only valid with taskType 'lego'/
  )
})

test('AudioGen.run requires Float32Array referenceAudio', async (t) => {
  await rejectRunOptions(
    t,
    { referenceAudio: new Int16Array([1, 2]) },
    /referenceAudio must be a Float32Array/
  )
})

test('AudioGen.run requires stereo sourceAudio', async (t) => {
  await rejectRunOptions(
    t,
    { sourceAudio: new Float32Array([1, 2, 3]) },
    /sourceAudio must be interleaved stereo/
  )
})

test('AudioGen.run requires stereo referenceAudio', async (t) => {
  await rejectRunOptions(
    t,
    { referenceAudio: new Float32Array([1, 2, 3]) },
    /referenceAudio must be interleaved stereo/
  )
})

test('AudioGen.run rejects non-finite referenceAudio samples', async (t) => {
  await rejectRunOptions(
    t,
    { referenceAudio: new Float32Array([0, Number.NaN]) },
    /referenceAudio must contain only finite samples/
  )
})

test('AudioGen.edit chains Flow-Edit and Repaint operations in exact order', async (t) => {
  const { gen, received } = createHarness()
  const pcm = stereoSource(2, 0.1).pcm

  const response = await gen
    .edit({ pcm, sampleRate: 48000, channels: 2 })
    .edit({
      from: { caption: 'original pop', lyrics: 'old words' },
      to: { caption: 'guitar pop-rock', lyrics: 'new words' },
      nMin: 0.2,
      nMax: 0.8,
      nAvg: 2
    })
    .repaint({
      caption: 'analog synth solo',
      lyrics: '[Instrumental]',
      start: 1,
      end: 2,
      mode: RepaintMode.Balanced,
      strength: 0.5
    })
    .flowEdit({
      from: { caption: 'guitar pop-rock' },
      to: { caption: 'dark synthwave' }
    })
    .run({ seed: 10 })
  await response.await()

  const job = received()
  t.is(job.type, 'edit')
  t.is(job.seed, 10)
  t.is(job.sourceAudio, pcm)
  t.alike(
    job.editOperations.map((operation) => operation.type),
    [
      AudioEditOperationType.FlowEdit,
      AudioEditOperationType.Repaint,
      AudioEditOperationType.FlowEdit
    ],
    'operation order and repeated types are preserved'
  )
  t.is(job.editOperations[0].sourceCaption, 'original pop')
  t.is(job.editOperations[0].targetCaption, 'guitar pop-rock')
  t.is(job.editOperations[1].caption, 'analog synth solo')
  t.is(job.editOperations[1].start, 1)
  t.is(job.editOperations[1].end, 2)
  t.is(job.editOperations[2].nMin, 0)
  t.is(job.editOperations[2].nMax, 1)
  t.is(job.editOperations[2].nAvg, 1)
})

test('AudioGen.edit accepts Int16 output PCM and converts it for native', async (t) => {
  const { gen, received } = createHarness()
  const input = new Int16Array(EDIT_SAMPLE_RATE * 0.04 * EDIT_CHANNELS)
  input[0] = 32767
  input[1] = -32768
  input[2] = 16384
  input[3] = -16384

  const response = await gen
    .edit({ pcm: input, sampleRate: 48000, channels: 2 })
    .repaint({ caption: 'new intro', start: 0 })
    .run()
  await response.await()

  const source = received().sourceAudio
  t.ok(source instanceof Float32Array)
  t.is(source.length, input.length)
  t.is(source[0], 1)
  t.is(source[1], -1)
})

test('AudioGen.edit validates source and operation-specific ranges', async (t) => {
  const { gen } = createHarness()
  const source = stereoSource(1)

  await t.exception(
    () =>
      gen
        .edit({
          pcm: new Float32Array(44100 * EDIT_CHANNELS),
          sampleRate: 44100,
          channels: EDIT_CHANNELS
        })
        .repaint({ caption: 'test', start: 0 })
        .run(),
    /sampleRate must be 48000/
  )

  t.exception(
    () =>
      gen.edit(source).flowEdit({
        from: { caption: 'source' },
        to: { caption: 'target' },
        nMin: 0.8,
        nMax: 0.2
      }),
    /0 <= nMin <= nMax <= 1/
  )

  t.exception(
    () => gen.edit(source).repaint({ caption: 'test', start: 4, end: 2 }),
    /end must be greater/
  )
})

test('AudioGen.edit rejects Float32 PCM outside [-1, 1] and accepts the bounds', async (t) => {
  const { gen } = createHarness()

  const high = stereoSource(1).pcm
  high[0] = 1.0001
  await t.exception(
    () =>
      gen
        .edit({ pcm: high, sampleRate: EDIT_SAMPLE_RATE, channels: EDIT_CHANNELS })
        .repaint({ caption: 'test', start: 0 })
        .run(),
    /finite samples in \[-1, 1\]/
  )

  const low = stereoSource(1).pcm
  low[1] = -1.0001
  await t.exception(
    () =>
      gen
        .edit({ pcm: low, sampleRate: EDIT_SAMPLE_RATE, channels: EDIT_CHANNELS })
        .repaint({ caption: 'test', start: 0 })
        .run(),
    /finite samples in \[-1, 1\]/
  )

  const { gen: bounded, received } = createHarness()
  const pcm = stereoSource(1).pcm
  pcm[0] = 1
  pcm[1] = -1
  const response = await bounded
    .edit({ pcm, sampleRate: EDIT_SAMPLE_RATE, channels: EDIT_CHANNELS })
    .repaint({ caption: 'test', start: 0 })
    .run()
  await response.await()
  t.is(received().sourceAudio[0], 1)
  t.is(received().sourceAudio[1], -1)
})

test('AudioGen.edit rejects Repaint ranges outside the source duration', (t) => {
  const { gen } = createHarness()
  const source = stereoSource(1)

  t.exception(
    () => gen.edit(source).repaint({ caption: 'test', start: 0, end: 1.5 }),
    /repaint.end must be within the source duration/
  )
  t.exception(
    () => gen.edit(source).repaint({ caption: 'test', start: 1.5 }),
    /repaint.start must be within the source duration/
  )
})

test('AudioGen.edit rejects Repaint ranges shorter than one latent frame', (t) => {
  const { gen } = createHarness()
  const source = stereoSource(1)

  t.exception(
    () => gen.edit(source).repaint({ caption: 'test', start: 0, end: 0.02 }),
    /at least one latent frame/
  )
  t.exception(
    () => gen.edit(source).repaint({ caption: 'test', start: 0.99 }),
    /at least one latent frame/
  )
})

test('AudioGen.edit rejects FlowEdit on sft DiT and allows turbo variants', (t) => {
  const sft = createHarness({ modelDir: '/tmp/acestep-models', ditVariant: 'sft' }).gen
  const source = stereoSource(1)
  t.exception(
    () =>
      sft.edit(source).flowEdit({
        from: { caption: 'source' },
        to: { caption: 'target' }
      }),
    /turbo DiT variants only/
  )

  const turbo = createHarness({ modelDir: '/tmp/acestep-models', ditVariant: 'turbo-q8' }).gen
  turbo.edit(source).flowEdit({
    from: { caption: 'source' },
    to: { caption: 'target' }
  })
  t.pass('turbo-q8 FlowEdit is accepted')
})

test('AudioEditSession requires operations and is single-use', async (t) => {
  const { gen } = createHarness()
  const source = stereoSource(1)

  await t.exception(() => gen.edit(source).run(), /requires at least one/)

  const session = gen.edit(source).repaint({ caption: 'new ending', start: 0 })
  const response = await session.run()
  await response.await()

  await t.exception(() => session.run(), /may only be called once/)
  t.exception(
    () =>
      session.flowEdit({
        from: { caption: 'source' },
        to: { caption: 'target' }
      }),
    /cannot modify/
  )
})

test('AudioGen.run rejects non-finite sourceAudio samples', async (t) => {
  await rejectRunOptions(
    t,
    { sourceAudio: new Float32Array([Number.POSITIVE_INFINITY, 0]) },
    /sourceAudio must contain only finite samples/
  )
})

test('AudioGen.run requires finite audioCoverStrength', async (t) => {
  await rejectRunOptions(
    t,
    { audioCoverStrength: Number.NaN },
    /audioCoverStrength must be a finite number/
  )
})

test('AudioGen.run requires finite coverNoiseStrength', async (t) => {
  await rejectRunOptions(
    t,
    { coverNoiseStrength: Number.POSITIVE_INFINITY },
    /coverNoiseStrength must be a finite number/
  )
})
