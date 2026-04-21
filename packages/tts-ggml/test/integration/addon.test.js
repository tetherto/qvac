'use strict'

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const fs = require('bare-fs')

const { loadChatterboxTTS, runChatterboxTTS, runChatterboxTTSWithSplit } = require('../utils/runChatterboxTTS')
const { ensureChatterboxModels, ensureWhisperModel } = require('../utils/downloadModel')
const { loadWhisper, runWhisper } = require('../utils/runWhisper')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'
const isDarwin = platform === 'darwin'

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

  console.log(`\n=== English synthesis (${englishSentences.length} sentences, tier: ${INPUT_SENTENCES}) ===`)
  const model = await loadChatterboxTTS({
    modelDir: modelsDir,
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
  // the option flows end-to-end without errors.
  const TTSGgml = require('../..')
  const model = new TTSGgml({
    files: { modelDir: modelsDir },
    referenceAudio: path.join(__dirname, '..', 'reference-audio', 'jfk.wav'),
    config: { language: 'en', outputSampleRate: 16000 },
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
