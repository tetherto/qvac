'use strict'

// Supertonic engine integration smoke + basic config / cancel coverage.
// Mirrors the per-engine integration shape used in
// qvac-lib-infer-onnx-tts/test/unit/supertonic.inference.test.js but
// runs against the real native ggml backend instead of the JS mock.

const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')

const { loadSupertonicTTS, runSupertonicTTS } = require('../utils/runSupertonicTTS')
const { ensureSupertonicModel } = require('../utils/downloadModel')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

test('Supertonic TTS (ggml): basic synthesis returns ~44.1 kHz audio + stats', { timeout: 600000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureSupertonicModel({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) { t.pass('Skipped: Supertonic GGUF not available'); return }

  const model = await loadSupertonicTTS({
    supertonicModelPath: download.path,
    voice: 'F1',
    language: 'en',
    useGPU: false
  })
  try {
    const wavPath = isMobile ? undefined : path.join(baseDir, 'test', 'output', 'supertonic-en.wav')
    const result = await runSupertonicTTS(
      model,
      { text: 'The supertonic engine produces high quality speech in real time.', saveWav: !isMobile, wavOutputPath: wavPath },
      { minSamples: 10000, maxSamples: 5000000, minDurationMs: 250, maxDurationMs: 300000 }
    )
    console.log(result.output)

    t.ok(result.passed, 'supertonic synth passes expectations')
    t.ok(result.data.sampleCount > 0, 'supertonic produced audio')
    t.is(result.data.reportedSampleRate, 44100, 'supertonic reports 44.1 kHz native sample rate')
    if (result.data.stats) {
      t.ok(typeof result.data.stats.realTimeFactor === 'number', 'supertonic stats include RTF')
      t.ok(typeof result.data.stats.audioDurationMs === 'number', 'supertonic stats include audio duration')
      t.ok(typeof result.data.stats.backendDevice === 'number', 'supertonic stats include backendDevice')
      t.ok(typeof result.data.stats.backendId === 'number', 'supertonic stats include backendId')
    }
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})

test('Supertonic TTS (ggml): cancel mid-flight rejects the response', { timeout: 600000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureSupertonicModel({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) { t.pass('Skipped: Supertonic GGUF not available'); return }

  const model = await loadSupertonicTTS({
    supertonicModelPath: download.path,
    voice: 'F1',
    language: 'en',
    useGPU: false
  })
  try {
    const response = await model.run({ type: 'text', input: 'Cancel this synthesis call before it completes.' })
    setTimeout(() => { response.cancel().catch(() => {}) }, 50)

    let failed = false
    try {
      await response.await()
    } catch (e) {
      failed = true
      console.log('  cancel rejected with: ' + e.message)
    }
    t.ok(failed, 'cancelled supertonic response should reject')
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})

test('Supertonic TTS (ggml): runStream emits per-sentence chunks with chunkIndex / sentenceChunk / isLast', { timeout: 600000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureSupertonicModel({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) { t.pass('Skipped: Supertonic GGUF not available'); return }

  const TTSGgml = require('@qvac/tts-ggml')
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel: download.path },
    voice: 'F1',
    config: { language: 'en', useGPU: false },
    opts: { stats: true }
  })
  await model.load()
  try {
    const text = 'First sentence. Second sentence. Third sentence here.'
    const response = await model.runStream(text, { maxChunkScalars: 30 })
    const chunkIndices = []
    const sentenceChunks = []
    const isLastFlags = []
    let totalSamples = 0
    let lastSampleRate = null
    await response
      .onUpdate(d => {
        if (d && d.outputArray) {
          chunkIndices.push(d.chunkIndex)
          sentenceChunks.push(d.sentenceChunk)
          isLastFlags.push(!!d.isLast)
          totalSamples += d.outputArray.length
          if (d.sampleRate) lastSampleRate = d.sampleRate
        }
      })
      .await()

    t.ok(chunkIndices.length >= 2, `runStream produced multiple chunks (got ${chunkIndices.length})`)
    for (let i = 0; i < chunkIndices.length; i++) {
      t.is(chunkIndices[i], i, `chunk ${i} carries chunkIndex=${i}`)
      t.ok(typeof sentenceChunks[i] === 'string' && sentenceChunks[i].length > 0,
        `chunk ${i} carries non-empty sentenceChunk`)
    }
    t.is(isLastFlags.filter(Boolean).length, 1, 'exactly one isLast=true emitted')
    t.is(isLastFlags[isLastFlags.length - 1], true, 'final chunk carries isLast=true')
    t.is(lastSampleRate, 44100, 'supertonic sentence-stream chunks report 44.1 kHz')
    t.ok(totalSamples > 0, 'stream produced audio samples')
    if (response.stats) {
      t.ok(response.stats.totalSamples >= totalSamples * 0.95,
        'merged stats totalSamples roughly matches concatenated chunk samples')
    }
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})

test('Supertonic TTS (ggml): runStreaming with async iterator emits one job per yielded sentence', { timeout: 600000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureSupertonicModel({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) { t.pass('Skipped: Supertonic GGUF not available'); return }

  const TTSGgml = require('@qvac/tts-ggml')
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel: download.path },
    voice: 'F1',
    config: { language: 'en', useGPU: false },
    opts: { stats: true }
  })
  await model.load()
  try {
    async function * yields () {
      yield 'First yielded sentence.'
      yield 'Second yielded sentence.'
      yield 'Third yielded sentence.'
    }
    const response = await model.runStreaming(yields())
    const updates = []
    await response.onUpdate(d => {
      if (d && d.outputArray) updates.push(d)
    }).await()

    t.is(updates.length, 3, 'one chunk per yielded sentence')
    t.is(updates[0].chunkIndex, 0, 'chunk 0 has chunkIndex=0')
    t.is(updates[2].chunkIndex, 2, 'chunk 2 has chunkIndex=2')
    t.ok(updates.every(u => u.isLast === undefined),
      'isLast is undefined for async-iter mode (count not known up-front)')
    t.ok(updates.every(u => u.sampleRate === 44100),
      'every chunk reports 44.1 kHz native sample rate')
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})

test('Supertonic TTS (ggml): voice + steps + speed knobs survive ttsParams round-trip', { timeout: 600000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureSupertonicModel({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) { t.pass('Skipped: Supertonic GGUF not available'); return }

  const model = await loadSupertonicTTS({
    supertonicModelPath: download.path,
    voice: 'F1',
    steps: 4,
    speed: 1.0,
    language: 'en',
    useGPU: false
  })
  try {
    const params = model._buildTtsParams()
    t.is(params.voice, 'F1')
    t.is(params.steps, 4)
    t.is(params.speed, 1)

    const result = await runSupertonicTTS(
      model,
      { text: 'Voice and steps test.' },
      { minSamples: 5000 }
    )
    t.ok(result.passed, 'voice+steps run passes expectations')
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})
