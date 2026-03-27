'use strict'

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const { loadChatterboxTTS, runChatterboxTTS } = require('../utils/runChatterboxTTS')
const { loadSupertonicTTS, runSupertonicTTS } = require('../utils/runSupertonicTTS')
const { ensureChatterboxModels, ensureSupertonicModels, ensureSupertonicModelsMultilingual, ensureWhisperModel } = require('../utils/downloadModel')
const { loadWhisper, runWhisper } = require('../utils/runWhisper')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'
const isDarwin = platform === 'darwin'

const CHATTERBOX_VARIANT = os.getEnv('CHATTERBOX_VARIANT') || 'fp32'
const VARIANT_SUFFIX = CHATTERBOX_VARIANT === 'fp32' ? '' : `_${CHATTERBOX_VARIANT}`

function chatterboxPath (modelDir, baseName, isMultilingual = false) {
  const suffix = isMultilingual ? '' : VARIANT_SUFFIX
  return path.join(modelDir, `${baseName}${suffix}.onnx`)
}

function chatterboxLmPath (modelDir) {
  return path.join(modelDir, `language_model${VARIANT_SUFFIX}.onnx`)
}

const DATASET = [
  'The quick brown fox jumps over the lazy dog.',
  'How are you doing today?',
  'Artificial intelligence is transforming the world.',
  'The weather is beautiful outside.'
]

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

test('Chatterbox TTS: Basic synthesis test', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'chatterbox')

  console.log('\n=== Ensuring Chatterbox models ===')
  const downloadResult = await ensureChatterboxModels({ targetDir: modelDir, variant: CHATTERBOX_VARIANT })
  t.ok(downloadResult.success, 'Chatterbox models should be downloaded')
  if (!downloadResult.success) {
    console.log('Failed to download Chatterbox models, skipping test')
    return
  }

  const modelParams = {
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(modelDir, 'speech_encoder'),
    embedTokensPath: chatterboxPath(modelDir, 'embed_tokens'),
    conditionalDecoderPath: chatterboxPath(modelDir, 'conditional_decoder'),
    languageModelPath: chatterboxLmPath(modelDir),
    language: 'en'
  }

  console.log('\n=== Loading Chatterbox TTS model ===')
  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'Chatterbox TTS model should be loaded')
  t.ok(model.addon, 'Addon should be created')

  console.log('\n=== Running Chatterbox TTS synthesis ===')
  const text = 'Hello world! This is a test of the Chatterbox text to speech system.'

  // Note: Synthetic reference audio causes longer outputs than real speech reference
  const expectation = {
    minSamples: 10000,
    maxSamples: 500000,
    minDurationMs: 400,
    maxDurationMs: 20000
  }

  const result = await runChatterboxTTS(model, { text, saveWav: true }, expectation)
  console.log(result.output)

  t.ok(result.passed, 'Chatterbox TTS synthesis should pass expectations')
  t.ok(result.data.sampleCount > 0, 'Chatterbox TTS should produce audio samples')
  t.is(result.data.sampleRate, 24000, 'Sample rate should be 24kHz')

  if (result.data?.stats) {
    console.log(`Inference stats: ${JSON.stringify(result.data.stats)}`)
  }

  // Unload model
  console.log('\n=== Unloading Chatterbox TTS model ===')
  await model.unload()
  t.pass('Model unloaded successfully')

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('CHATTERBOX BASIC TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`Text: "${text}"`)
  console.log(`Samples: ${result.data.sampleCount}`)
  console.log(`Duration: ${result.data.durationMs?.toFixed(0) || 'N/A'}ms`)
  console.log(`Sample rate: ${result.data.sampleRate}Hz`)
  if (result.data.stats) {
    console.log(`Total time: ${result.data.stats.totalTime}s`)
    console.log(`Real-time factor: ${result.data.stats.realTimeFactor}`)
    console.log(`Tokens/sec: ${result.data.stats.tokensPerSecond}`)
  }
  console.log('='.repeat(60))
})

test('Chatterbox TTS: Multiple sentences synthesis with WER verification', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'chatterbox')
  const whisperModelDir = path.join(baseDir, 'models', 'whisper')

  console.log('\n=== Ensuring Chatterbox models ===')
  const downloadResult = await ensureChatterboxModels({ targetDir: modelDir, variant: CHATTERBOX_VARIANT })
  t.ok(downloadResult.success, 'Chatterbox models should be downloaded')
  if (!downloadResult.success) {
    console.log('Failed to download Chatterbox models, skipping test')
    return
  }

  if (isDarwin) { // TODO - let it verify WER for all desktop platforms once adding ai-run-linux-gpu and ai-run-windows-gpu runners
    console.log('\n=== Ensuring Whisper model ===')
    const whisperModelPath = path.join(whisperModelDir, 'ggml-small.bin')
    await ensureWhisperModel(whisperModelPath)
    t.pass('Whisper model downloaded')
  } else {
    console.log('\n=== Skipping Whisper model download (non-darwin) ===')
  }

  const modelParams = {
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(modelDir, 'speech_encoder'),
    embedTokensPath: chatterboxPath(modelDir, 'embed_tokens'),
    conditionalDecoderPath: chatterboxPath(modelDir, 'conditional_decoder'),
    languageModelPath: chatterboxLmPath(modelDir),
    language: 'en'
  }

  const expectation = {
    minSamples: 5000,
    maxSamples: 500000,
    minDurationMs: 200,
    maxDurationMs: 20000
  }

  console.log('\n=== Loading Chatterbox TTS model ===')
  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'Chatterbox TTS model should be loaded')

  const results = []

  for (let i = 0; i < DATASET.length; i++) {
    const text = DATASET[i]
    console.log(`\n--- Chatterbox TTS ${i + 1}/${DATASET.length}: "${text}" ---`)

    const result = await runChatterboxTTS(model, { text }, expectation)
    console.log(result.output)

    t.ok(result.passed, `Chatterbox TTS synthesis ${i + 1} should pass expectations`)
    t.ok(result.data.sampleCount > 0, `Chatterbox TTS synthesis ${i + 1} should produce samples`)

    const wavBuffer = result.data?.wavBuffer ? Buffer.from(result.data.wavBuffer) : null
    results.push({
      text,
      sampleCount: result.data.sampleCount,
      durationMs: result.data.durationMs,
      stats: result.data.stats,
      wavBuffer
    })
  }

  // Unload TTS model
  await model.unload()
  console.log('\nChatterbox TTS model unloaded')

  const werResults = []
  if (isDarwin) { // TODO - let it verify WER for all desktop platforms once adding ai-run-linux-gpu and ai-run-windows-gpu runners
    console.log('\n=== Loading Whisper model for WER verification ===')
    const whisperParams = {
      modelName: 'ggml-small.bin',
      diskPath: whisperModelDir,
      language: 'en'
    }
    const whisperModel = await loadWhisper(whisperParams)
    t.ok(whisperModel, 'Whisper model should be loaded')

    // Run WER verification for each synthesized audio
    for (let i = 0; i < results.length; i++) {
      const { text, wavBuffer } = results[i]
      if (!wavBuffer) {
        console.log(`\n--- Whisper ${i + 1}/${results.length}: Skipped (no WAV buffer) ---`)
        continue
      }

      console.log(`\n--- Whisper ${i + 1}/${results.length}: "${text}" ---`)
      const whisperResult = await runWhisper(whisperModel, text, wavBuffer)
      console.log(`>>> [WHISPER] Word Error Rate: ${whisperResult.wer}`)

      t.ok(whisperResult.wer <= 0.4, `WER ${i + 1} should be <= 0.4 (got ${whisperResult.wer})`)
      werResults.push({ text, wer: whisperResult.wer })
    }

    // Unload Whisper model
    await whisperModel.unload()
    console.log('\nWhisper model unloaded')
  } else {
    console.log('\n=== Skipping WER verification (non-darwin) ===')
  }

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('CHATTERBOX MULTIPLE SENTENCES TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`Total sentences: ${DATASET.length}`)
  for (let i = 0; i < results.length; i++) {
    const rtf = results[i].stats?.realTimeFactor ?? 'N/A'
    const werInfo = werResults[i] ? `, WER: ${werResults[i].wer}` : ''
    console.log(`  ${i + 1}. "${results[i].text.substring(0, 40)}..." - ${results[i].sampleCount} samples, ${results[i].durationMs?.toFixed(0) || 'N/A'}ms, RTF: ${rtf}${werInfo}`)
  }
  if (werResults.length > 0) {
    const avgWer = werResults.reduce((sum, r) => sum + r.wer, 0) / werResults.length
    console.log(`Average WER: ${avgWer.toFixed(2)}`)
  }
  console.log('='.repeat(60))
})

test('Chatterbox TTS: Reload model from English to Spanish', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'chatterbox')

  console.log('\n=== Ensuring Chatterbox models ===')
  const downloadResult = await ensureChatterboxModels({ targetDir: modelDir, variant: CHATTERBOX_VARIANT })
  t.ok(downloadResult.success, 'Chatterbox models should be downloaded')
  if (!downloadResult.success) {
    console.log('Failed to download Chatterbox models, skipping test')
    return
  }

  const modelParams = {
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(modelDir, 'speech_encoder'),
    embedTokensPath: chatterboxPath(modelDir, 'embed_tokens'),
    conditionalDecoderPath: chatterboxPath(modelDir, 'conditional_decoder'),
    languageModelPath: chatterboxLmPath(modelDir),
    language: 'en'
  }

  const expectation = {
    minSamples: 5000,
    maxSamples: 5000000,
    minDurationMs: 200,
    maxDurationMs: 300000
  }

  console.log('\n=== Loading Chatterbox TTS model (English) ===')
  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'TTS model should be loaded')
  t.ok(model.addon, 'Addon should be created')

  console.log('\n=== Running TTS in English ===')
  const englishText = 'Hello world! This is a test of the text to speech system.'
  // On mobile, skip saveWav since we don't need the output files
  const englishSaveWav = !isMobile
  const englishWavPath = englishSaveWav ? path.join(baseDir, 'test', 'output', 'chatterbox-english-test.wav') : undefined
  const englishResult = await runChatterboxTTS(model, { text: englishText, saveWav: englishSaveWav, wavOutputPath: englishWavPath }, expectation)
  console.log(englishResult.output)
  t.ok(englishResult.passed, 'English TTS should pass expectations')
  t.ok(englishResult.data.sampleCount > 0, 'English TTS should produce audio samples')
  console.log(`English TTS produced ${englishResult.data.sampleCount} samples`)

  console.log('\n=== Reloading model with Spanish language ===')
  await model.reload({ language: 'es' })
  console.log('Model reloaded with Spanish configuration')

  console.log('\n=== Running TTS in Spanish ===')
  const spanishText = 'Hola mundo! Esta es una prueba del sistema de texto a voz.'
  const spanishSaveWav = !isMobile
  const spanishWavPath = spanishSaveWav ? path.join(baseDir, 'test', 'output', 'chatterbox-spanish-test.wav') : undefined
  const spanishResult = await runChatterboxTTS(model, { text: spanishText, saveWav: spanishSaveWav, wavOutputPath: spanishWavPath }, expectation)
  console.log(spanishResult.output)
  t.ok(spanishResult.passed, 'Spanish TTS should pass expectations')
  t.ok(spanishResult.data.sampleCount > 0, 'Spanish TTS should produce audio samples')
  console.log(`Spanish TTS produced ${spanishResult.data.sampleCount} samples`)

  console.log('\n=== Unloading model ===')
  await model.unload()
  t.pass('Model unloaded')

  console.log('\n' + '='.repeat(60))
  console.log('RELOAD MODEL TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`English TTS: ${englishResult.data.sampleCount} samples, ${englishResult.data.durationMs?.toFixed(0) || 'N/A'}ms`)
  console.log(`Spanish TTS: ${spanishResult.data.sampleCount} samples, ${spanishResult.data.durationMs?.toFixed(0) || 'N/A'}ms`)
  console.log('='.repeat(60))
})

// ---------------------------------------------------------------------------
// Multilingual Chatterbox TTS tests
// ---------------------------------------------------------------------------

const MULTILINGUAL_DATASET = {
  es: 'Hola mundo. Esta es una prueba del sistema de texto a voz.'
}

test('Chatterbox Multilingual TTS: Synthesis across multiple languages', { timeout: 3600000 }, async (t) => {
  if (isMobile) {
    t.pass('Skipped on mobile')
    return
  }

  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'chatterbox-multilingual')

  console.log('\n=== Ensuring Chatterbox multilingual models ===')
  const downloadResult = await ensureChatterboxModels({ targetDir: modelDir, language: 'multilingual', variant: CHATTERBOX_VARIANT })
  t.ok(downloadResult.success, 'Chatterbox multilingual models should be downloaded')
  if (!downloadResult.success) {
    console.log('Failed to download Chatterbox multilingual models, skipping test')
    return
  }

  const modelParams = {
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(modelDir, 'speech_encoder', true),
    embedTokensPath: chatterboxPath(modelDir, 'embed_tokens', true),
    conditionalDecoderPath: chatterboxPath(modelDir, 'conditional_decoder', true),
    languageModelPath: chatterboxLmPath(modelDir),
    language: 'es'
  }

  const expectation = {
    minSamples: 5000,
    maxSamples: 5000000,
    minDurationMs: 200,
    maxDurationMs: 300000
  }

  const languages = Object.keys(MULTILINGUAL_DATASET)
  const firstLang = languages[0]

  console.log(`\n=== Loading Chatterbox multilingual model (${firstLang}) ===`)
  modelParams.language = firstLang
  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'Multilingual TTS model should be loaded')
  t.ok(model.addon, 'Addon should be created')

  const results = []

  for (let i = 0; i < languages.length; i++) {
    const lang = languages[i]
    const text = MULTILINGUAL_DATASET[lang]

    if (i > 0) {
      console.log(`\n=== Reloading model for language: ${lang} ===`)
      await model.reload({ language: lang })
    }

    console.log(`\n--- Multilingual TTS [${lang}] ${i + 1}/${languages.length}: "${text}" ---`)

    const saveWav = !isMobile
    const wavPath = saveWav ? path.join(baseDir, 'test', 'output', `chatterbox-multilingual-${lang}.wav`) : undefined
    const result = await runChatterboxTTS(model, { text, saveWav, wavOutputPath: wavPath }, expectation)
    console.log(result.output)

    t.ok(result.passed, `Multilingual TTS [${lang}] should pass expectations`)
    t.ok(result.data.sampleCount > 0, `Multilingual TTS [${lang}] should produce audio samples`)
    t.is(result.data.sampleRate, 24000, `Sample rate for [${lang}] should be 24kHz`)

    results.push({
      lang,
      text,
      sampleCount: result.data.sampleCount,
      durationMs: result.data.durationMs,
      stats: result.data.stats
    })
  }

  console.log('\n=== Unloading multilingual model ===')
  await model.unload()
  t.pass('Model unloaded successfully')

  console.log('\n' + '='.repeat(60))
  console.log('CHATTERBOX MULTILINGUAL TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`Languages tested: ${languages.join(', ')}`)
  for (const r of results) {
    const rtf = r.stats?.realTimeFactor ?? 'N/A'
    console.log(`  [${r.lang}] "${r.text.substring(0, 40)}..." - ${r.sampleCount} samples, ${r.durationMs?.toFixed(0) || 'N/A'}ms, RTF: ${rtf}`)
  }
  console.log('='.repeat(60))
})

test('Chatterbox Multilingual TTS: WER verification for Spanish', { timeout: 1800000 }, async (t) => {
  if (isMobile) {
    t.pass('Skipped on mobile')
    return
  }

  if (!isDarwin) {
    console.log('WER test skipped (non-darwin)')
    t.pass('WER test skipped (non-darwin)')
    return
  }

  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'chatterbox-multilingual')
  const whisperModelDir = path.join(baseDir, 'models', 'whisper')

  console.log('\n=== Ensuring Chatterbox multilingual models ===')
  const downloadResult = await ensureChatterboxModels({ targetDir: modelDir, language: 'multilingual', variant: CHATTERBOX_VARIANT })
  t.ok(downloadResult.success, 'Chatterbox multilingual models should be downloaded')
  if (!downloadResult.success) {
    console.log('Failed to download Chatterbox multilingual models, skipping test')
    return
  }

  console.log('\n=== Ensuring Whisper model ===')
  const whisperModelPath = path.join(whisperModelDir, 'ggml-small.bin')
  await ensureWhisperModel(whisperModelPath)

  const modelParams = {
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(modelDir, 'speech_encoder', true),
    embedTokensPath: chatterboxPath(modelDir, 'embed_tokens', true),
    conditionalDecoderPath: chatterboxPath(modelDir, 'conditional_decoder', true),
    languageModelPath: chatterboxLmPath(modelDir),
    language: 'es'
  }

  const expectation = {
    minSamples: 5000,
    maxSamples: 5000000,
    minDurationMs: 200,
    maxDurationMs: 300000
  }

  const text = 'Hola mundo. Esta es una prueba del sistema de texto a voz.'

  console.log('\n=== Loading Chatterbox multilingual model (es) ===')
  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'Multilingual TTS model should be loaded')

  console.log('\n=== Running TTS in Spanish ===')
  const result = await runChatterboxTTS(model, { text }, expectation)
  console.log(result.output)
  t.ok(result.passed, 'Spanish TTS should pass expectations')
  t.ok(result.data.sampleCount > 0, 'Spanish TTS should produce audio samples')

  await model.unload()
  console.log('TTS model unloaded')

  if (!result.data?.wavBuffer) {
    t.fail('No WAV buffer for Whisper verification')
    return
  }

  console.log('\n=== Loading Whisper model for WER verification ===')
  const whisperModel = await loadWhisper({
    modelName: 'ggml-small.bin',
    diskPath: whisperModelDir,
    language: 'es'
  })
  t.ok(whisperModel, 'Whisper model should be loaded')

  const { wer } = await runWhisper(whisperModel, text, result.data.wavBuffer)
  const werPct = (wer * 100).toFixed(1)
  console.log(`>>> [WHISPER] Spanish WER: ${werPct}%`)

  t.ok(wer <= 0.5, `Spanish WER should be <= 50% (got ${werPct}%)`)

  await whisperModel.unload()
  console.log('Whisper model unloaded')

  console.log('\n' + '='.repeat(60))
  console.log('CHATTERBOX MULTILINGUAL WER TEST SUMMARY')
  console.log('='.repeat(60))
  console.log('Language: es')
  console.log(`Text: "${text}"`)
  console.log(`WER: ${werPct}%`)
  console.log('='.repeat(60))
})

// ---------------------------------------------------------------------------
// Supertonic TTS tests
// ---------------------------------------------------------------------------

const SUPERTONIC_SAMPLE_RATE = 44100
const SUPERTONIC_WER_THRESHOLD = 0.3

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
    supertonicMultilingual: false
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
    supertonicMultilingual: false
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

  for (let i = 0; i < DATASET.length; i++) {
    const text = DATASET[i]
    console.log(`\n--- Supertonic TTS ${i + 1}/${DATASET.length}: "${text}" ---`)

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
  console.log(`Total sentences: ${DATASET.length}`)
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
  const modelParams = { modelDir, voiceName: 'F1', language: 'en', supertonicMultilingual: false }

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
  if (wer > SUPERTONIC_WER_THRESHOLD) {
    console.log(`WER test failed: ${werPct}% > ${SUPERTONIC_WER_THRESHOLD * 100}%`)
  } else {
    console.log(`WER test passed: ${werPct}% <= ${SUPERTONIC_WER_THRESHOLD * 100}%`)
  }

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
