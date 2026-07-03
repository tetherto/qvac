'use strict'

// LavaSR enhancer integration + regression tests.
//
// The construct-time tests need no models and always run in CI. They pin:
// enhancer + Chatterbox native chunk streaming is now supported (constructs and
// forwards both knobs — the addon enhances each chunk seam-free), and a
// misconfigured enhancer can't silently become a no-op (an unknown
// enhancer.type throws). The model-backed tests assert the enhanced output is
// reported as 48 kHz for both engines (incl. Chatterbox native streaming);
// they are gated on the converted enhancer GGUF being staged, and skip cleanly
// otherwise.
//
// Stage the enhancer GGUF via scripts/convert-lavasr-enhancer-to-gguf.py (from
// the public LavaSRcpp ONNX release) into models/lavasr/lavasr-enhancer.gguf,
// or set LAVASR_ENHANCER_GGUF.

const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')
const TTSGgml = require('@qvac/tts-ggml')

const {
  ensureLavaSREnhancerGguf,
  ensureSupertonicModel,
  ensureChatterboxModels
} = require('../utils/downloadModel')
const { resolveRefWavPath } = require('../utils/runChatterboxTTS')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

async function runAndCollect (model, text) {
  let samples = 0
  let sampleRate = null
  const response = await model.run({ input: text, type: 'text' })
  await response
    .onUpdate(d => {
      if (d && d.outputArray) samples += d.outputArray.length
      if (d && d.sampleRate) sampleRate = d.sampleRate
    })
    .await()
  return { samples, sampleRate, stats: response.stats || null }
}

// ---- Construct-time regression tests (no models, always run) ----

test('Chatterbox: enhancer + streamChunkTokens constructs and forwards both', (t) => {
  // Previously rejected; streaming enhancement is now supported, so this must
  // construct and forward both knobs to the addon (which runs the streaming
  // enhancer per chunk).
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_CHATTERBOX,
    files: {
      t3Model: './models/chatterbox-t3-turbo.gguf',
      s3genModel: './models/chatterbox-s3gen.gguf',
      lavasrEnhancer: './models/lavasr/lavasr-enhancer.gguf'
    },
    streamChunkTokens: 25,
    config: { language: 'en' }
  })
  const params = model._buildTtsParams()
  t.is(params.streamChunkTokens, 25, 'streamChunkTokens forwarded')
  t.is(
    params.lavasrEnhancerPath,
    './models/lavasr/lavasr-enhancer.gguf',
    'enhancer path forwarded alongside streamChunkTokens'
  )
})

test('enhancer with an unknown type is rejected at construction', (t) => {
  t.exception(
    () => new TTSGgml({
      engine: TTSGgml.ENGINE_SUPERTONIC,
      files: {
        supertonicModel: './models/supertonic.gguf',
        lavasrEnhancer: './models/lavasr/lavasr-enhancer.gguf'
      },
      enhancer: { type: 'lavasr-typo' },
      config: { language: 'en' }
    }),
    /unknown enhancer\.type/,
    'a typo in enhancer.type throws instead of silently disabling enhancement'
  )
})

test('enhancer block with no GGUF path leaves enhancement off (no throw)', (t) => {
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel: './models/supertonic.gguf' },
    enhancer: { type: 'lavasr' },
    config: { language: 'en' }
  })
  t.absent(
    model._buildTtsParams().lavasrEnhancerPath,
    'no path resolved -> enhancement stays off (the path is the on switch)'
  )
})

// ---- Model-backed tests (gated on staged models) ----

test('Supertonic + LavaSR enhancer reports 48 kHz enhanced output', { timeout: 600000 }, async (t) => {
  const baseDir = getBaseDir()
  const enh = await ensureLavaSREnhancerGguf({ targetDir: path.join(baseDir, 'models', 'lavasr') })
  if (!enh.success) { t.comment('LavaSR enhancer GGUF not staged; skipping.'); t.pass('skipped — no enhancer GGUF'); return }
  const dl = await ensureSupertonicModel({ targetDir: path.join(baseDir, 'models') })
  if (!dl.success) { t.fail('Supertonic GGUF not available — registry fetch failed.'); return }

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel: dl.path, lavasrEnhancer: enh.path },
    voice: 'F1',
    config: { language: 'en', useGPU: false },
    opts: { stats: true }
  })
  await model.load()
  try {
    const r = await runAndCollect(model, 'LavaSR neural enhancement upsamples this to forty-eight kilohertz.')
    t.is(r.sampleRate, 48000, 'enhanced supertonic output reports 48 kHz')
    t.ok(r.samples > 0, 'enhanced synthesis produced audio')
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})

test('Supertonic without enhancer reports native 44.1 kHz (backward compat)', { timeout: 600000 }, async (t) => {
  const baseDir = getBaseDir()
  const dl = await ensureSupertonicModel({ targetDir: path.join(baseDir, 'models') })
  if (!dl.success) { t.fail('Supertonic GGUF not available — registry fetch failed.'); return }

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel: dl.path },
    voice: 'F1',
    config: { language: 'en', useGPU: false },
    opts: { stats: true }
  })
  await model.load()
  try {
    const r = await runAndCollect(model, 'No enhancement here, just the native engine output.')
    t.is(r.sampleRate, 44100, 'un-enhanced supertonic reports 44.1 kHz')
    t.ok(r.samples > 0, 'synthesis produced audio')
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})

test('Chatterbox + LavaSR enhancer (batch) reports 48 kHz enhanced output', { timeout: 900000 }, async (t) => {
  const baseDir = getBaseDir()
  const enh = await ensureLavaSREnhancerGguf({ targetDir: path.join(baseDir, 'models', 'lavasr') })
  if (!enh.success) { t.comment('LavaSR enhancer GGUF not staged; skipping.'); t.pass('skipped — no enhancer GGUF'); return }
  const modelsDir = path.join(baseDir, 'models')
  const dl = await ensureChatterboxModels({ targetDir: modelsDir })
  if (!dl.success) { t.fail('Chatterbox GGUFs not available — registry fetch failed.'); return }
  const dir = dl.targetDir || modelsDir

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_CHATTERBOX,
    files: {
      modelDir: dir,
      t3Model: path.join(dir, 'chatterbox-t3-turbo.gguf'),
      s3genModel: path.join(dir, 'chatterbox-s3gen.gguf'),
      lavasrEnhancer: enh.path
    },
    referenceAudio: resolveRefWavPath({}),
    config: { language: 'en', useGPU: false },
    opts: { stats: true }
  })
  await model.load()
  try {
    const r = await runAndCollect(model, 'Chatterbox output neurally upsampled to forty-eight kilohertz.')
    t.is(r.sampleRate, 48000, 'enhanced chatterbox output reports 48 kHz')
    t.ok(r.samples > 0, 'enhanced synthesis produced audio')
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})

test('Chatterbox + LavaSR enhancer + native chunk streaming emits 48 kHz chunks', { timeout: 900000 }, async (t) => {
  const baseDir = getBaseDir()
  const enh = await ensureLavaSREnhancerGguf({ targetDir: path.join(baseDir, 'models', 'lavasr') })
  if (!enh.success) { t.comment('LavaSR enhancer GGUF not staged; skipping.'); t.pass('skipped — no enhancer GGUF'); return }
  const modelsDir = path.join(baseDir, 'models')
  const dl = await ensureChatterboxModels({ targetDir: modelsDir })
  if (!dl.success) { t.fail('Chatterbox GGUFs not available — registry fetch failed.'); return }
  const dir = dl.targetDir || modelsDir

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_CHATTERBOX,
    files: {
      modelDir: dir,
      t3Model: path.join(dir, 'chatterbox-t3-turbo.gguf'),
      s3genModel: path.join(dir, 'chatterbox-s3gen.gguf'),
      lavasrEnhancer: enh.path
    },
    referenceAudio: resolveRefWavPath({}),
    streamChunkTokens: 25, // native chunk streaming + enhancer (the QVAC-21482 path)
    config: { language: 'en', useGPU: false },
    opts: { stats: true }
  })
  await model.load()
  try {
    const updates = []
    const response = await model.run({
      input: 'Streaming Chatterbox audio, neurally upsampled to forty-eight kilohertz, one chunk at a time.',
      type: 'text'
    })
    await response.onUpdate(d => { if (d && d.outputArray) updates.push(d) }).await()

    const total = updates.reduce((acc, u) => acc + u.outputArray.length, 0)
    t.ok(updates.length >= 1, 'streamed at least one chunk event')
    t.ok(total > 0, 'streamed enhanced audio produced samples')
    // Every chunk that carries audio must be tagged at the enhanced 48 kHz rate
    // (not the engine's native 24 kHz) — the mislabel this feature prevents.
    for (const u of updates) {
      if (u.outputArray.length > 0 && u.sampleRate != null) {
        t.is(u.sampleRate, 48000, 'streamed enhanced chunk reports 48 kHz')
      }
    }
    const isLastCount = updates.filter(u => u.isLast === true).length
    t.ok(isLastCount <= 1, 'at most one isLast=true across streamed chunks')
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})
