'use strict'

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const { loadChatterboxTTS, runChatterboxTTS } = require('../utils/runChatterboxTTS')
const { ensureChatterboxModels } = require('../utils/downloadModel')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

test('Reload model: English then Spanish', { timeout: 1800000, skip: isMobile }, async (t) => {
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
  const englishResult = await runChatterboxTTS(model, { text: englishText, saveWav: true, wavOutputPath: path.join(baseDir, 'test', 'output', 'chatterbox-english-test.wav') }, expectation)
  console.log(englishResult.output)
  t.ok(englishResult.passed, 'English TTS should pass expectations')
  t.ok(englishResult.data.sampleCount > 0, 'English TTS should produce audio samples')
  console.log(`English TTS produced ${englishResult.data.sampleCount} samples`)

  console.log('\n=== Reloading model with Spanish language ===')
  await model.reload({ language: 'es' })
  console.log('Model reloaded with Spanish configuration')

  console.log('\n=== Running TTS in Spanish ===')
  const spanishText = 'Hola mundo! Esta es una prueba del sistema de texto a voz.'
  const spanishResult = await runChatterboxTTS(model, { text: spanishText, saveWav: true, wavOutputPath: path.join(baseDir, 'test', 'output', 'chatterbox-spanish-test.wav') }, expectation)
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
