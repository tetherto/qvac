'use strict'

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const { loadChatterboxTTS, runChatterboxTTS } = require('../utils/runChatterboxTTS')
const { ensureChatterboxModels, ensureWhisperModel } = require('../utils/downloadModel')
const { loadWhisper, runWhisper } = require('../utils/runWhisper')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

// Returns base directory for models - uses global.testDir on mobile, current dir otherwise
function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

test('Chatterbox TTS: Basic synthesis test', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'chatterbox')

  // Ensure Chatterbox models are downloaded
  console.log('\n=== Ensuring Chatterbox models ===')
  const downloadResult = await ensureChatterboxModels({ targetDir: modelDir })
  t.ok(downloadResult.success, 'Chatterbox models should be downloaded')
  if (!downloadResult.success) {
    console.log('Failed to download Chatterbox models, skipping test')
    return
  }

  const modelParams = {
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: path.join(modelDir, 'speech_encoder.onnx'),
    embedTokensPath: path.join(modelDir, 'embed_tokens.onnx'),
    conditionalDecoderPath: path.join(modelDir, 'conditional_decoder.onnx'),
    languageModelPath: path.join(modelDir, 'language_model.onnx'),
    language: 'en'
  }

  // Load model
  console.log('\n=== Loading Chatterbox TTS model ===')
  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'Chatterbox TTS model should be loaded')
  t.ok(model.addon, 'Addon should be created')

  // Run synthesis
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

  // Ensure Chatterbox models are downloaded
  console.log('\n=== Ensuring Chatterbox models ===')
  const downloadResult = await ensureChatterboxModels({ targetDir: modelDir })
  t.ok(downloadResult.success, 'Chatterbox models should be downloaded')
  if (!downloadResult.success) {
    console.log('Failed to download Chatterbox models, skipping test')
    return
  }

  // Ensure Whisper model is downloaded (only on non-mobile platforms)
  if (!isMobile) {
    console.log('\n=== Ensuring Whisper model ===')
    const whisperModelPath = path.join(whisperModelDir, 'ggml-small.bin')
    await ensureWhisperModel(whisperModelPath)
    t.pass('Whisper model downloaded')
  } else {
    console.log('\n=== Skipping Whisper model download (mobile) ===')
  }

  const modelParams = {
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: path.join(modelDir, 'speech_encoder.onnx'),
    embedTokensPath: path.join(modelDir, 'embed_tokens.onnx'),
    conditionalDecoderPath: path.join(modelDir, 'conditional_decoder.onnx'),
    languageModelPath: path.join(modelDir, 'language_model.onnx'),
    language: 'en'
  }

  const dataset = [
    'The quick brown fox jumps over the lazy dog.',
    'How are you doing today?',
    'Artificial intelligence is transforming the world.',
    'The weather is beautiful outside.'
  ]

  const expectation = {
    minSamples: 5000,
    maxSamples: 500000,
    minDurationMs: 200,
    maxDurationMs: 20000
  }

  // Load model
  console.log('\n=== Loading Chatterbox TTS model ===')
  const model = await loadChatterboxTTS(modelParams)
  t.ok(model, 'Chatterbox TTS model should be loaded')

  const results = []

  // Run TTS for each text sample
  for (let i = 0; i < dataset.length; i++) {
    const text = dataset[i]
    console.log(`\n--- Chatterbox TTS ${i + 1}/${dataset.length}: "${text}" ---`)

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

  // WER verification with Whisper (skip on mobile - too slow)
  const werResults = []
  if (!isMobile) {
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
    console.log('\n=== Skipping WER verification (mobile) ===')
  }

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('CHATTERBOX MULTIPLE SENTENCES TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`Total sentences: ${dataset.length}`)
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
  const downloadResult = await ensureChatterboxModels({ targetDir: modelDir })
  t.ok(downloadResult.success, 'Chatterbox models should be downloaded')
  if (!downloadResult.success) {
    console.log('Failed to download Chatterbox models, skipping test')
    return
  }

  const modelParams = {
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: path.join(modelDir, 'speech_encoder.onnx'),
    embedTokensPath: path.join(modelDir, 'embed_tokens.onnx'),
    conditionalDecoderPath: path.join(modelDir, 'conditional_decoder.onnx'),
    languageModelPath: path.join(modelDir, 'language_model.onnx'),
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
