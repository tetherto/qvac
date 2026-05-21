'use strict'

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const fs = require('bare-fs')

const { loadChatterboxTTS, runChatterboxTTS, runChatterboxTTSWithSplit, runChatterboxStreaming, resolveRefWavPath } = require('../utils/runChatterboxTTS')
const { ensureChatterboxModels, ensureWhisperModel } = require('../utils/downloadModel')
const { loadWhisper, runWhisper } = require('../utils/runWhisper')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'
const isDarwin = platform === 'darwin'
const forceNoGpu = os.getEnv('NO_GPU') === 'true'

const INPUT_SENTENCES = (isMobile ? 'short' : os.getEnv('INPUT_SENTENCES')) || 'short'
const useSplit = INPUT_SENTENCES !== 'short'

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

const ENGLISH_SENTENCES_SHORT = [
  'The quick brown fox jumps over the lazy dog.',
  'How are you doing today?'
]

function getEnglishSentences () {
  if (INPUT_SENTENCES === 'short') return ENGLISH_SENTENCES_SHORT
  const { en } = require(`../data/sentences-${INPUT_SENTENCES}`)
  return en
}

test('Chatterbox TTS (ggml): English synthesis + optional WER verification', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelsDir = path.join(baseDir, 'models')
  const whisperModelDir = path.join(baseDir, 'models', 'whisper')

  console.log('\n=== Ensuring Chatterbox GGUFs ===')
  const download = await ensureChatterboxModels({ targetDir: modelsDir })
  if (!download.success) {
    console.log('Chatterbox GGUFs not available locally; see instructions above.')
    t.pass('Skipped: Chatterbox GGUFs not available locally')
    return
  }
  t.ok(download.success, 'Chatterbox GGUFs should be available')

  if (isDarwin) {
    console.log('\n=== Ensuring Whisper model (for WER verification) ===')
    const whisperModelPath = path.join(whisperModelDir, 'ggml-small.bin')
    await ensureWhisperModel(whisperModelPath)
    t.pass('Whisper model present')
  }

  const expectation = {
    minSamples: 5000,
    maxSamples: 5000000,
    minDurationMs: 200,
    maxDurationMs: 300000
  }

  const werEntries = []
  const englishSentences = getEnglishSentences()

  // `ensureChatterboxModels` may resolve to a different dir on Android
  // (the adb-push-friendly candidate paths under /sdcard/...), so use
  // the dir it actually found the GGUFs in.
  const resolvedModelDir = download.targetDir
  console.log(`\n=== English synthesis (${englishSentences.length} sentences, tier: ${INPUT_SENTENCES}, modelDir: ${resolvedModelDir}) ===`)
  const model = await loadChatterboxTTS({
    modelDir: resolvedModelDir,
    language: 'en'
  })
  t.ok(model, 'Chatterbox (ggml) model should be loaded')

  const runner = useSplit ? runChatterboxTTSWithSplit : runChatterboxTTS

  for (let i = 0; i < englishSentences.length; i++) {
    const text = englishSentences[i]
    const preview = text.substring(0, 60) + (text.length > 60 ? '...' : '')
    console.log(`\n--- English ${i + 1}/${englishSentences.length}: "${preview}" ---`)

    const saveWav = !isMobile
    const wavPath = saveWav ? path.join(baseDir, 'test', 'output', `chatterbox-english-${i + 1}.wav`) : undefined

    const result = await runner(model, { text, saveWav, wavOutputPath: wavPath }, expectation)
    console.log(result.output)

    t.ok(result.passed, `English TTS ${i + 1} should pass expectations`)
    t.ok(result.data.sampleCount > 0, `English TTS ${i + 1} should produce audio samples`)
    t.is(result.data.reportedSampleRate, 24000, 'Sample rate should be native 24 kHz')

    const wavBuffer = result.data?.wavBuffer ? Buffer.from(result.data.wavBuffer) : null
    werEntries.push({ text, lang: 'en', wavBuffer, sampleCount: result.data.sampleCount, durationMs: result.data.durationMs })
  }

  await model.unload()
  t.pass('Chatterbox model unloaded')

  console.log('\n=== WER verification ===')
  if (!isDarwin) {
    t.pass('WER verification skipped (non-darwin)')
  } else if (INPUT_SENTENCES !== 'short') {
    t.pass('WER verification skipped (non-short input)')
  } else {
    const whisperModel = await loadWhisper({
      modelName: 'ggml-small.bin',
      diskPath: whisperModelDir,
      language: 'en'
    })
    t.ok(whisperModel, 'Whisper model should be loaded')

    for (let i = 0; i < werEntries.length; i++) {
      const entry = werEntries[i]
      if (!entry.wavBuffer) {
        console.log(`\n--- Whisper ${i + 1}/${werEntries.length}: skipped (no WAV buffer) ---`)
        continue
      }

      console.log(`\n--- Whisper ${i + 1}/${werEntries.length}: "${entry.text.substring(0, 50)}..." ---`)
      const whisperResult = await runWhisper(whisperModel, entry.text, entry.wavBuffer)
      const werPct = (whisperResult.wer * 100).toFixed(1)
      console.log(`>>> [WHISPER] [en] WER: ${werPct}%`)

      const threshold = 0.4
      t.ok(whisperResult.wer <= threshold, `WER should be ≤ ${threshold * 100}% (got ${werPct}%)`)
    }

    await whisperModel.unload()
    console.log('Whisper model unloaded')
  }

  console.log('\n' + '='.repeat(60))
  console.log('CHATTERBOX (ggml) TEST SUMMARY')
  console.log('='.repeat(60))
  for (const e of werEntries) {
    console.log(`  [${e.lang}] ${e.sampleCount} samples, ${e.durationMs?.toFixed(0) || 'N/A'}ms - "${e.text.substring(0, 50)}..."`)
  }
  console.log('='.repeat(60))
})

test('Chatterbox TTS (ggml): synthesizes without referenceAudio using the built-in voice baked into the S3Gen GGUF', { timeout: 600000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelsDir = path.join(baseDir, 'models')

  const download = await ensureChatterboxModels({ targetDir: modelsDir })
  if (!download.success) {
    t.pass('Skipped: Chatterbox GGUFs not available locally')
    return
  }

  // referenceAudio omitted on purpose: chatterbox::Engine falls back to
  // the voice profile baked into the S3Gen GGUF (see qvac-tts.cpp's
  // built-in voice condition).  ChatterboxModel::validateConfig only
  // rejects referenceAudio when it's set AND the file is missing; an
  // empty/undefined value flows through to the engine cleanly.
  const TTSGgml = require('@qvac/tts-ggml')
  const model = new TTSGgml({
    files: { modelDir: download.targetDir },
    config: { language: 'en', ...(forceNoGpu ? { useGPU: false } : {}) },
    opts: { stats: true }
  })

  try {
    await model.load()

    const response = await model.run({
      type: 'text',
      input: 'Hello from the built-in voice.'
    })
    let samples = 0
    let reportedSampleRate = null
    await response
      .onUpdate(data => {
        if (data && data.outputArray) samples += data.outputArray.length
        if (data && data.sampleRate) reportedSampleRate = data.sampleRate
      })
      .await()

    t.ok(samples > 5000, `built-in voice should produce > 5000 samples (got ${samples})`)
    t.is(reportedSampleRate, 24000, 'built-in voice still emits at 24 kHz native rate')
    if (response.stats) {
      t.ok(response.stats.totalSamples > 0, 'built-in voice run reports stats')
      t.ok(typeof response.stats.realTimeFactor === 'number', 'built-in voice run reports RTF')
    }
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})

test('Chatterbox TTS (ggml): outputSampleRate option is accepted (pass-through for now)', { timeout: 300000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelsDir = path.join(baseDir, 'models')

  const download = await ensureChatterboxModels({ targetDir: modelsDir })
  if (!download.success) {
    t.pass('Skipped: Chatterbox GGUFs not available locally')
    return
  }

  // Native output is always 24 kHz for Chatterbox; outputSampleRate resampling
  // is reserved for the persistent-engine milestone.  This test just verifies
  // the option flows end-to-end without errors.  Reference audio routed
  // through `resolveRefWavPath` so the mobile-asset path (stage-copied
  // into `Library/Caches/jfk.wav` by the test runner) is preferred over
  // the in-bundle `test/reference-audio/jfk.wav` that `__dirname` would
  // resolve to (the latter is not readable from native code on iOS).
  const TTSGgml = require('@qvac/tts-ggml')
  const model = new TTSGgml({
    files: { modelDir: download.targetDir },
    referenceAudio: resolveRefWavPath({}),
    config: { language: 'en', outputSampleRate: 16000, ...(forceNoGpu ? { useGPU: false } : {}) },
    opts: { stats: true }
  })
  await model.load()

  const response = await model.run({ type: 'text', input: 'Hello world.' })
  let samples = 0
  await response
    .onUpdate(data => {
      if (data && data.outputArray) samples += data.outputArray.length
    })
    .await()

  t.ok(samples > 0, 'Should produce non-empty output audio')
  await model.unload()

  if (!fs.existsSync(path.join(baseDir, 'test', 'output'))) {
    // Just a touchpoint so CI logs show output dir; not strictly required.
    try { fs.mkdirSync(path.join(baseDir, 'test', 'output'), { recursive: true }) } catch (e) { /* ignore */ }
  }
})

test('Chatterbox TTS (ggml): native C++ chunk streaming via streamChunkTokens', { timeout: 600000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelsDir = path.join(baseDir, 'models')

  const download = await ensureChatterboxModels({ targetDir: modelsDir })
  if (!download.success) {
    t.pass('Skipped: Chatterbox GGUFs not available locally')
    return
  }

  // streamChunkTokens > 0 activates the native Engine chunked S3Gen+HiFT
  // loop.  The addon publishes each chunk's PCM via the outputQueue so
  // every `onUpdate` carries a distinct chunk of audio rather than one
  // concatenated final result.  Reference audio via `resolveRefWavPath`
  // (see the outputSampleRate test above for the mobile-asset
  // rationale).
  const TTSGgml = require('@qvac/tts-ggml')
  const model = new TTSGgml({
    files: { modelDir: download.targetDir },
    referenceAudio: resolveRefWavPath({}),
    streamChunkTokens: 25,
    streamFirstChunkTokens: 10,
    cfmSteps: 1,
    config: { language: 'en', ...(forceNoGpu ? { useGPU: false } : {}) },
    opts: { stats: true }
  })
  await model.load()
  t.pass('Chatterbox (ggml) model loaded with native streaming')

  const response = await model.run({
    type: 'text',
    input: 'The quick brown fox jumps over the lazy dog. This is a slightly longer sentence to produce multiple native chunks.'
  })

  const chunkIndices = []
  let totalSamples = 0
  let sawIsLast = false
  let lastSeenIsLast = null
  await response
    .onUpdate(data => {
      if (data && data.outputArray) {
        chunkIndices.push(data.chunkIndex)
        totalSamples += data.outputArray.length
        if (data.isLast === true) sawIsLast = true
        lastSeenIsLast = data.isLast
      }
    })
    .await()

  t.ok(chunkIndices.length >= 2, `native streaming should emit multiple chunks (got ${chunkIndices.length})`)
  t.ok(totalSamples > 0, 'native streaming should produce audio samples')
  for (let i = 0; i < chunkIndices.length; i++) {
    t.is(chunkIndices[i], i, `chunk ${i} should carry chunkIndex=${i}`)
  }
  t.ok(sawIsLast, 'one of the chunks should carry isLast=true')
  t.is(lastSeenIsLast, true, 'the final chunk should carry isLast=true')

  await model.unload()
  t.pass('Model unloaded after native streaming')
})

test('Chatterbox TTS (ggml): streaming input + streaming PCM output (runStreaming + onUpdate)', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelsDir = path.join(baseDir, 'models')

  console.log('\n=== Ensuring Chatterbox GGUFs (streaming) ===')
  const download = await ensureChatterboxModels({ targetDir: modelsDir })
  if (!download.success) {
    t.pass('Skipped: Chatterbox GGUFs not available locally')
    return
  }
  t.ok(download.success, 'Chatterbox GGUFs should be available')

  const model = await loadChatterboxTTS({
    modelDir: download.targetDir,
    language: 'en'
  })
  t.ok(model, 'Chatterbox (ggml) model should be loaded')

  const phrases = [
    'First phrase arrives from the upstream text stream.',
    'A short pause could sit between chunks.',
    'Each yield is one discrete synthesis job.'
  ]

  const expectation = {
    minSamples: 15000,
    maxSamples: 5000000,
    minDurationMs: 400,
    maxDurationMs: 300000
  }

  const saveWav = !isMobile
  const wavOutputPath = saveWav
    ? path.join(baseDir, 'test', 'output', 'chatterbox-streaming.wav')
    : undefined

  console.log(`\n=== Running Chatterbox IO stream synthesis (runStreaming, ${phrases.length} phrases) ===`)
  const result = await runChatterboxStreaming(
    model,
    { phrases, saveWav, wavOutputPath },
    expectation
  )
  console.log(result.output)

  t.ok(result.passed, 'Streaming synthesis should pass expectations')
  t.ok(result.data.sampleCount > 0, 'Streaming should produce audio samples')
  t.is(result.data.reportedSampleRate, 24000, 'Streaming sample rate is native 24 kHz')
  t.is(
    result.data.streamChunkCount,
    phrases.length,
    'runStreaming should emit one chunk per yielded phrase'
  )
  t.is(result.data.sentenceChunks.length, phrases.length)
  for (let i = 0; i < phrases.length; i++) {
    t.is(
      result.data.sentenceChunks[i],
      phrases[i],
      `chunk ${i} sentenceChunk should match the streamed-in phrase`
    )
  }

  await model.unload()
  t.pass('Chatterbox model unloaded')
})
