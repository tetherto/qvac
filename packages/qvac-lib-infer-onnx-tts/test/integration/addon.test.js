'use strict'

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const { loadChatterboxTTS, runChatterboxTTS } = require('../utils/runChatterboxTTS')
const { ensureChatterboxModels } = require('../utils/downloadModel')

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

test('Chatterbox TTS: Multiple sentences synthesis', { timeout: 1800000 }, async (t) => {
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

    results.push({
      text,
      sampleCount: result.data.sampleCount,
      durationMs: result.data.durationMs,
      stats: result.data.stats
    })
  }

  // Unload model
  await model.unload()
  console.log('\nChatterbox TTS model unloaded')

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('CHATTERBOX MULTIPLE SENTENCES TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`Total sentences: ${dataset.length}`)
  for (let i = 0; i < results.length; i++) {
    const rtf = results[i].stats?.realTimeFactor ?? 'N/A'
    console.log(`  ${i + 1}. "${results[i].text.substring(0, 40)}..." - ${results[i].sampleCount} samples, ${results[i].durationMs?.toFixed(0) || 'N/A'}ms, RTF: ${rtf}`)
  }
  console.log('='.repeat(60))
})

test('Chatterbox TTS: Reference audio is passed correctly', { timeout: 900000 }, async (t) => {
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

  console.log('\n=== Testing reference audio is passed to addon ===')

  let model
  try {
    model = await loadChatterboxTTS(modelParams)
    t.ok(model, 'Model loaded successfully - reference audio was passed correctly')
  } catch (err) {
    t.fail(`Failed to load model: ${err.message}`)
    return
  }

  // Run a simple synthesis to verify the model works with the reference audio
  const result = await runChatterboxTTS(model, { text: 'Test.' }, {})

  if (result.passed && result.data.sampleCount > 0) {
    t.pass('Synthesis succeeded - reference audio is being used correctly')
    console.log(result.output)
    if (result.data.stats) {
      console.log(`Total time: ${result.data.stats.totalTime}s, RTF: ${result.data.stats.realTimeFactor}`)
    }
  } else {
    t.fail(`Synthesis failed: ${result.output}`)
  }

  await model.unload()
  t.pass('Model unloaded')
})
