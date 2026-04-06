'use strict'

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const { loadChatterboxTTS, runChatterboxTTS, runChatterboxTTSWithSplit } = require('../utils/runChatterboxTTS')
const { loadSupertonicTTS, runSupertonicTTS } = require('../utils/runSupertonicTTS')
const { ensureChatterboxModels, ensureSupertonicModels, ensureSupertonicModelsMultilingual, ensureWhisperModel } = require('../utils/downloadModel')
const { loadWhisper, runWhisper } = require('../utils/runWhisper')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'
const isDarwin = platform === 'darwin'

const CHATTERBOX_VARIANT = os.getEnv('CHATTERBOX_VARIANT') || 'fp32'
const VARIANT_SUFFIX = CHATTERBOX_VARIANT === 'fp32' ? '' : `_${CHATTERBOX_VARIANT}`
const INPUT_SENTENCES = (isMobile ? 'short' : os.getEnv('INPUT_SENTENCES')) || 'short'
const useSplit = INPUT_SENTENCES !== 'short'

function chatterboxPath (modelDir, baseName, isMultilingual = false) {
  const suffix = isMultilingual ? '' : VARIANT_SUFFIX
  return path.join(modelDir, `${baseName}${suffix}.onnx`)
}

function chatterboxLmPath (modelDir) {
  return path.join(modelDir, `language_model${VARIANT_SUFFIX}.onnx`)
}

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

const ENGLISH_SENTENCES_SHORT = [
  'The quick brown fox jumps over the lazy dog.',
  'How are you doing today?'
]

const MULTILINGUAL_SENTENCES_SHORT = {
  es: 'Hola mundo. Esta es una prueba del sistema de texto a voz.',
  he: 'שלום עולם.',
  ko: '안녕하세요. 한글입니다.'
}

function getEnglishSentences () {
  if (INPUT_SENTENCES === 'short') return ENGLISH_SENTENCES_SHORT
  const data = require(`../data/sentences-${INPUT_SENTENCES}`)
  return [data.en]
}

function getMultilingualSentences () {
  if (INPUT_SENTENCES === 'short') return MULTILINGUAL_SENTENCES_SHORT
  const { en, ...multilingual } = require(`../data/sentences-${INPUT_SENTENCES}`)
  return multilingual
}

function runChatterboxSynth (model, params, expectation) {
  if (useSplit) return runChatterboxTTSWithSplit(model, params, expectation)
  return runChatterboxTTS(model, params, expectation)
}

// ---------------------------------------------------------------------------
// Chatterbox English + Reload + WER
// ---------------------------------------------------------------------------

test('Chatterbox TTS: English + Spanish synthesis and WER verification', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const enModelDir = path.join(baseDir, 'models', 'chatterbox')
  const multiModelDir = path.join(baseDir, 'models', 'chatterbox-multilingual')
  const whisperModelDir = path.join(baseDir, 'models', 'whisper')

  console.log('\n=== Ensuring Chatterbox English models ===')
  const enDownload = await ensureChatterboxModels({ targetDir: enModelDir, variant: CHATTERBOX_VARIANT })
  t.ok(enDownload.success, 'Chatterbox English models should be downloaded')
  if (!enDownload.success) return

  console.log('\n=== Ensuring Chatterbox multilingual models ===')
  const multiDownload = await ensureChatterboxModels({ targetDir: multiModelDir, language: 'multilingual', variant: CHATTERBOX_VARIANT })
  t.ok(multiDownload.success, 'Chatterbox multilingual models should be downloaded')
  if (!multiDownload.success) return

  if (isDarwin) {
    console.log('\n=== Ensuring Whisper model ===')
    const whisperModelPath = path.join(whisperModelDir, 'ggml-small.bin')
    await ensureWhisperModel(whisperModelPath)
    t.pass('Whisper model downloaded')
  }

  const expectation = {
    minSamples: 5000,
    maxSamples: 5000000,
    minDurationMs: 200,
    maxDurationMs: 300000
  }

  const werEntries = []
  const englishSentences = getEnglishSentences()

  console.log(`\n=== [1/2] English synthesis (${englishSentences.length} sentences, tier: ${INPUT_SENTENCES}) ===`)
  const enModel = await loadChatterboxTTS({
    tokenizerPath: path.join(enModelDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(enModelDir, 'speech_encoder'),
    embedTokensPath: chatterboxPath(enModelDir, 'embed_tokens'),
    conditionalDecoderPath: chatterboxPath(enModelDir, 'conditional_decoder'),
    languageModelPath: chatterboxLmPath(enModelDir),
    language: 'en'
  })
  t.ok(enModel, 'English TTS model should be loaded')

  for (let i = 0; i < englishSentences.length; i++) {
    const text = englishSentences[i]
    console.log(`\n--- English ${i + 1}/${englishSentences.length}: "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}" ---`)

    const saveWav = !isMobile
    const wavPath = saveWav ? path.join(baseDir, 'test', 'output', `chatterbox-english-${i + 1}.wav`) : undefined
    const result = await runChatterboxSynth(enModel, { text, saveWav, wavOutputPath: wavPath }, expectation)
    console.log(result.output)

    t.ok(result.passed, `English TTS ${i + 1} should pass expectations`)
    t.ok(result.data.sampleCount > 0, `English TTS ${i + 1} should produce audio samples`)

    const wavBuffer = result.data?.wavBuffer ? Buffer.from(result.data.wavBuffer) : null
    werEntries.push({ text, lang: 'en', wavBuffer, sampleCount: result.data.sampleCount, durationMs: result.data.durationMs })
  }

  await enModel.unload()
  t.pass('English model unloaded')

  console.log('\n=== [2/2] Spanish synthesis (multilingual model) ===')
  const multiModel = await loadChatterboxTTS({
    tokenizerPath: path.join(multiModelDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(multiModelDir, 'speech_encoder', true),
    embedTokensPath: chatterboxPath(multiModelDir, 'embed_tokens', true),
    conditionalDecoderPath: chatterboxPath(multiModelDir, 'conditional_decoder', true),
    languageModelPath: chatterboxLmPath(multiModelDir),
    language: 'es'
  })
  t.ok(multiModel, 'Multilingual TTS model should be loaded')

  const spanishText = 'Hola mundo! Esta es una prueba del sistema de texto a voz.'
  const spanishSaveWav = !isMobile
  const spanishWavPath = spanishSaveWav ? path.join(baseDir, 'test', 'output', 'chatterbox-spanish.wav') : undefined
  const spanishResult = await runChatterboxTTS(multiModel, { text: spanishText, saveWav: spanishSaveWav, wavOutputPath: spanishWavPath }, expectation)
  console.log(spanishResult.output)

  t.ok(spanishResult.passed, 'Spanish TTS should pass expectations')
  t.ok(spanishResult.data.sampleCount > 0, 'Spanish TTS should produce audio samples')

  const spanishWavBuffer = spanishResult.data?.wavBuffer ? Buffer.from(spanishResult.data.wavBuffer) : null
  werEntries.push({ text: spanishText, lang: 'es', wavBuffer: spanishWavBuffer, sampleCount: spanishResult.data.sampleCount, durationMs: spanishResult.data.durationMs })

  await multiModel.unload()
  t.pass('Multilingual model unloaded')

  console.log('\n=== WER verification ===')
  if (!isDarwin) {
    console.log('WER verification skipped (non-darwin)')
    t.pass('WER skipped (non-darwin)')
  } else if (INPUT_SENTENCES !== 'short') {
    console.log('WER verification skipped (non-short input)')
    t.pass('WER skipped (non-short input)')
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
        console.log(`\n--- Whisper ${i + 1}/${werEntries.length}: Skipped (no WAV buffer) ---`)
        continue
      }

      if (entry.lang !== 'en') {
        await whisperModel.reload({ whisperConfig: { language: entry.lang, translate: false } })
      }

      console.log(`\n--- Whisper ${i + 1}/${werEntries.length} [${entry.lang}]: "${entry.text.substring(0, 50)}..." ---`)
      const whisperResult = await runWhisper(whisperModel, entry.text, entry.wavBuffer)
      const werPct = (whisperResult.wer * 100).toFixed(1)
      console.log(`>>> [WHISPER] [${entry.lang}] WER: ${werPct}%`)

      const threshold = entry.lang === 'en' ? 0.4 : 0.5
      t.ok(whisperResult.wer <= threshold, `WER [${entry.lang}] should be <= ${threshold * 100}% (got ${werPct}%)`)
    }

    await whisperModel.unload()
    console.log('Whisper model unloaded')
  }

  console.log('\n' + '='.repeat(60))
  console.log('CHATTERBOX ENGLISH + SPANISH TEST SUMMARY')
  console.log('='.repeat(60))
  for (const e of werEntries) {
    console.log(`  [${e.lang}] ${e.sampleCount} samples, ${e.durationMs?.toFixed(0) || 'N/A'}ms - "${e.text.substring(0, 50)}..."`)
  }
  console.log('='.repeat(60))
})

// ---------------------------------------------------------------------------
// Chatterbox Multilingual TTS (parameterized by INPUT_SENTENCES)
// ---------------------------------------------------------------------------

test('Chatterbox Multilingual TTS: Synthesis across languages', { timeout: 3600000 }, async (t) => {
  if (isMobile) {
    t.pass('Skipped on mobile')
    return
  }

  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'chatterbox-multilingual')

  console.log('\n=== Ensuring Chatterbox multilingual models ===')
  const downloadResult = await ensureChatterboxModels({ targetDir: modelDir, language: 'multilingual', variant: CHATTERBOX_VARIANT })
  t.ok(downloadResult.success, 'Chatterbox multilingual models should be downloaded')
  if (!downloadResult.success) return

  const multilingualSentences = getMultilingualSentences()
  const languages = Object.keys(multilingualSentences)
  const firstLang = languages[0]

  const expectation = {
    minSamples: 5000,
    maxSamples: 5000000,
    minDurationMs: 200,
    maxDurationMs: 300000
  }

  const modelParams = {
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(modelDir, 'speech_encoder', true),
    embedTokensPath: chatterboxPath(modelDir, 'embed_tokens', true),
    conditionalDecoderPath: chatterboxPath(modelDir, 'conditional_decoder', true),
    languageModelPath: chatterboxLmPath(modelDir),
    language: firstLang
  }

  console.log(`\n=== Loading Chatterbox multilingual model (${firstLang}, tier: ${INPUT_SENTENCES}) ===`)
  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'Multilingual TTS model should be loaded')

  const results = []

  for (let i = 0; i < languages.length; i++) {
    const lang = languages[i]
    const text = multilingualSentences[lang]

    if (i > 0) {
      console.log(`\n=== Reloading model for language: ${lang} ===`)
      await model.reload({ language: lang })
    }

    console.log(`\n--- [${lang}] "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}" ---`)

    const saveWav = !isMobile
    const wavPath = saveWav
      ? path.join(baseDir, 'test', 'output', `chatterbox-multilingual-${lang}-${INPUT_SENTENCES}.wav`)
      : undefined

    const startTime = Date.now()
    const result = await runChatterboxSynth(model, { text, saveWav, wavOutputPath: wavPath }, expectation)
    const elapsedMs = Date.now() - startTime

    console.log(result.output)

    t.ok(result.passed, `[${lang}] ${INPUT_SENTENCES} should pass expectations`)
    t.ok(result.data.sampleCount > 0, `[${lang}] ${INPUT_SENTENCES} should produce audio`)
    t.is(result.data.sampleRate, 24000, `[${lang}] sample rate should be 24kHz`)

    results.push({ lang, text, sampleCount: result.data.sampleCount, durationMs: result.data.durationMs, elapsedMs, stats: result.data.stats })
  }

  console.log('\n=== Unloading multilingual model ===')
  await model.unload()
  t.pass('Model unloaded successfully')

  console.log('\n' + '='.repeat(60))
  console.log(`CHATTERBOX MULTILINGUAL TEST SUMMARY (tier: ${INPUT_SENTENCES})`)
  console.log('='.repeat(60))
  for (const r of results) {
    const durationSec = (r.durationMs || 0) / 1000
    const rtf = durationSec > 0 ? (r.elapsedMs / 1000 / durationSec).toFixed(2) : 'N/A'
    console.log(`  [${r.lang}] ${r.sampleCount} samples, ${r.durationMs?.toFixed(0) || 'N/A'}ms audio, RTF: ${rtf} - "${r.text.substring(0, 40)}..."`)
  }
  console.log('='.repeat(60))
})

// ---------------------------------------------------------------------------
// Supertonic TTS tests
// ---------------------------------------------------------------------------

const SUPERTONIC_SAMPLE_RATE = 44100
const SUPERTONIC_WER_THRESHOLD = 0.3

const SUPERTONIC_DATASET = [
  'The quick brown fox jumps over the lazy dog.',
  'How are you doing today?',
  'Artificial intelligence is transforming the world.',
  'The weather is beautiful outside.'
]

test('Supertonic TTS: Basic synthesis test', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'supertonic')

  console.log('\n=== Ensuring Supertonic models ===')
  const downloadResult = await ensureSupertonicModels({ targetDir: modelDir })
  t.ok(downloadResult.success, 'Supertonic models should be downloaded')
  if (!downloadResult.success) {
    console.log('Failed to download Supertonic models, skipping test')
    return
  }

  const modelParams = {
    modelDir,
    voiceName: 'F1',
    language: 'en',
    supertonicMultilingual: true
  }

  console.log('\n=== Loading Supertonic TTS model ===')
  const model = await loadSupertonicTTS(modelParams)
  t.ok(model, 'Supertonic TTS model should be loaded')
  t.ok(model.addon, 'Addon should be created')

  console.log('\n=== Running Supertonic TTS synthesis ===')
  const text = 'Hello world! This is a test of the Supertonic text to speech system.'

  const expectation = {
    minSamples: 10000,
    maxSamples: 500000,
    minDurationMs: 400,
    maxDurationMs: 20000
  }

  const saveWav = !isMobile
  const wavOutputPath = saveWav ? path.join(__dirname, '../output/supertonic-test.wav') : undefined
  const result = await runSupertonicTTS(model, { text, saveWav, wavOutputPath }, expectation)
  console.log(result.output)

  t.ok(result.passed, 'Supertonic TTS synthesis should pass expectations')
  t.ok(result.data.sampleCount > 0, 'Supertonic TTS should produce audio samples')
  t.is(SUPERTONIC_SAMPLE_RATE, 44100, 'Supertonic output sample rate is 44.1kHz')

  if (result.data?.stats) {
    console.log(`Inference stats: ${JSON.stringify(result.data.stats)}`)
  }

  console.log('\n=== Unloading Supertonic TTS model ===')
  await model.unload()
  t.pass('Model unloaded successfully')

  console.log('\n' + '='.repeat(60))
  console.log('SUPERTONIC BASIC TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`Text: "${text}"`)
  console.log(`Samples: ${result.data.sampleCount}`)
  console.log(`Duration: ${result.data.durationMs?.toFixed(0) || 'N/A'}ms`)
  console.log(`Sample rate: ${SUPERTONIC_SAMPLE_RATE}Hz`)
  if (result.data.stats) {
    console.log(`Total time: ${result.data.stats.totalTime}s`)
    console.log(`Real-time factor: ${result.data.stats.realTimeFactor}`)
    console.log(`Tokens/sec: ${result.data.stats.tokensPerSecond}`)
  }
  console.log('='.repeat(60))
})

test('Supertonic TTS: Multiple sentences synthesis', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'supertonic')

  console.log('\n=== Ensuring Supertonic models ===')
  const downloadResult = await ensureSupertonicModels({ targetDir: modelDir })
  t.ok(downloadResult.success, 'Supertonic models should be downloaded')
  if (!downloadResult.success) {
    console.log('Failed to download Supertonic models, skipping test')
    return
  }

  const modelParams = {
    modelDir,
    voiceName: 'F1',
    language: 'en',
    supertonicMultilingual: true
  }

  const expectation = {
    minSamples: 5000,
    maxSamples: 500000,
    minDurationMs: 200,
    maxDurationMs: 20000
  }

  console.log('\n=== Loading Supertonic TTS model ===')
  const model = await loadSupertonicTTS(modelParams)
  t.ok(model, 'Supertonic TTS model should be loaded')

  const results = []

  for (let i = 0; i < SUPERTONIC_DATASET.length; i++) {
    const text = SUPERTONIC_DATASET[i]
    console.log(`\n--- Supertonic TTS ${i + 1}/${SUPERTONIC_DATASET.length}: "${text}" ---`)

    const result = await runSupertonicTTS(model, { text }, expectation)
    console.log(result.output)

    t.ok(result.passed, `Supertonic TTS synthesis ${i + 1} should pass expectations`)
    t.ok(result.data.sampleCount > 0, `Supertonic TTS synthesis ${i + 1} should produce samples`)

    results.push({
      text,
      sampleCount: result.data.sampleCount,
      durationMs: result.data.durationMs,
      stats: result.data.stats
    })
  }

  await model.unload()
  console.log('\nSupertonic TTS model unloaded')

  console.log('\n' + '='.repeat(60))
  console.log('SUPERTONIC MULTIPLE SENTENCES TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`Total sentences: ${SUPERTONIC_DATASET.length}`)
  for (let i = 0; i < results.length; i++) {
    const rtf = results[i].stats?.realTimeFactor ?? 'N/A'
    console.log(`  ${i + 1}. "${results[i].text.substring(0, 40)}..." - ${results[i].sampleCount} samples, ${results[i].durationMs?.toFixed(0) || 'N/A'}ms, RTF: ${rtf}`)
  }
  console.log('='.repeat(60))
})

test('Supertonic TTS: WER test (TTS + Whisper)', { timeout: 1800000 }, async (t) => {
  if (!isDarwin) {
    console.log('WER test skipped (non-darwin)')
    t.pass('WER test skipped (non-darwin)')
    return
  }

  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'supertonic')
  const whisperPath = path.join(baseDir, 'models', 'whisper', 'ggml-small.bin')

  console.log('\n=== Ensuring Supertonic models ===')
  const supertonicResult = await ensureSupertonicModels({ targetDir: modelDir })
  t.ok(supertonicResult.success, 'Supertonic models should be downloaded')
  if (!supertonicResult.success) {
    console.log('Failed to download Supertonic models, skipping test')
    return
  }

  console.log('\n=== Ensuring Whisper model ===')
  const whisperResult = await ensureWhisperModel(whisperPath)
  if (!whisperResult.success) {
    t.skip('Whisper model not available - skipping WER test')
    return
  }

  const text = 'The quick brown fox jumps over the lazy dog.'
  const modelParams = { modelDir, voiceName: 'F1', language: 'en', supertonicMultilingual: true }

  console.log('\n=== Loading Supertonic TTS and running synthesis ===')
  const ttsModel = await loadSupertonicTTS(modelParams)
  t.ok(ttsModel, 'Supertonic TTS model should be loaded')

  const ttsResult = await runSupertonicTTS(ttsModel, { text }, {})
  t.ok(ttsResult.passed && ttsResult.data?.wavBuffer, 'TTS should produce WAV')
  await ttsModel.unload()

  if (!ttsResult.data?.wavBuffer) {
    t.fail('No WAV buffer for Whisper')
    return
  }

  console.log('\n=== Loading Whisper and transcribing ===')
  const whisperModel = await loadWhisper({
    modelName: 'ggml-small.bin',
    diskPath: path.join(baseDir, 'models', 'whisper'),
    language: 'en'
  })
  t.ok(whisperModel, 'Whisper model should be loaded')

  const { wer } = await runWhisper(whisperModel, text, ttsResult.data.wavBuffer)
  const werPct = (wer * 100).toFixed(1)

  t.ok(wer <= SUPERTONIC_WER_THRESHOLD, `WER should be <= ${SUPERTONIC_WER_THRESHOLD * 100}%, got ${werPct}%`)

  await whisperModel.unload()
})

test('Supertonic TTS multilingual (Spanish): basic synthesis with HF Supertone/supertonic-2 weights', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'supertonic-multilingual')

  console.log('\n=== Ensuring Supertonic multilingual models (HF supertonic-2) ===')
  const downloadResult = await ensureSupertonicModelsMultilingual({ targetDir: modelDir })
  t.ok(downloadResult.success, 'Supertonic multilingual models should be downloaded')
  if (!downloadResult.success) {
    console.log('Failed to download Supertonic multilingual models, skipping test')
    return
  }

  const modelParams = {
    modelDir,
    voiceName: 'F1',
    language: 'es',
    supertonicMultilingual: true
  }

  console.log('\n=== Loading Supertonic multilingual TTS model ===')
  const model = await loadSupertonicTTS(modelParams)
  t.ok(model, 'Supertonic multilingual TTS model should be loaded')

  const text =
    'Hola mundo. Esta es una prueba del sistema Supertonic de síntesis de voz en español.'
  const expectation = {
    minSamples: 8000,
    maxSamples: 800000,
    minDurationMs: 400,
    maxDurationMs: 30000
  }

  const result = await runSupertonicTTS(model, { text }, expectation)
  t.ok(result.passed, 'Supertonic multilingual Spanish synthesis should pass expectations')
  t.ok(result.data.sampleCount > 0, 'Supertonic multilingual should produce audio samples')

  await model.unload()
  console.log('\nSupertonic multilingual TTS model unloaded')
})
