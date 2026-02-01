'use strict'

const test = require('brittle')
const os = require('bare-os')
const { loadTTS, runTTS } = require('../utils/runTTS')
const { ensureTTSModelPair, ensureEspeakData } = require('../utils/downloadModel')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

const ENGLISH_MODEL = 'en_US-lessac-medium'
const SPANISH_MODEL = 'es_ES-davefx-medium'

test('Reload model from English to Spanish', { timeout: 300000, skip: isMobile }, async (t) => {
  // Step 1: Ensure espeak-ng-data is available
  console.log('\n=== Step 1: Ensuring espeak-ng-data ===')
  const espeakResult = await ensureEspeakData('./models/tts/espeak-ng-data')
  t.ok(espeakResult.success, 'espeak-ng-data should be available')

  // Step 2: Ensure English model
  console.log('\n=== Step 2: Ensuring English model ===')
  const englishModelResult = await ensureTTSModelPair(ENGLISH_MODEL)
  t.ok(englishModelResult.success, 'English model should be downloaded')

  // Step 3: Load TTS with English model
  console.log('\n=== Step 3: Loading TTS with English model ===')
  const englishParams = {
    mainModelUrl: `./models/tts/${ENGLISH_MODEL}.onnx`,
    configJsonPath: `./models/tts/${ENGLISH_MODEL}.onnx.json`,
    eSpeakDataPath: './models/tts/espeak-ng-data',
    language: 'en-us'
  }

  const model = await loadTTS(englishParams)
  t.ok(model, 'TTS model should be loaded')
  t.ok(model.addon, 'Addon should be created')

  // Step 4: Run TTS in English
  console.log('\n=== Step 4: Running TTS in English ===')
  const englishText = 'Hello world! This is a test of the text to speech system.'
  const englishExpectation = {
    minDurationMs: 2000,
    maxDurationMs: 6000,
    minSamples: 44000,
    maxSamples: 132000
  }

  const englishResult = await runTTS(model, { text: englishText }, englishExpectation)
  console.log(`English TTS result: ${englishResult.output}`)
  t.ok(englishResult.passed, 'English TTS should pass expectations')
  t.ok(englishResult.data.sampleCount > 0, 'English TTS should produce audio samples')
  console.log(`English TTS produced ${englishResult.data.sampleCount} samples`)

  // Step 5: Ensure Spanish model
  console.log('\n=== Step 5: Ensuring Spanish model ===')
  const spanishModelResult = await ensureTTSModelPair(SPANISH_MODEL)
  t.ok(spanishModelResult.success, 'Spanish model should be downloaded')

  // Step 6: Reload TTS with Spanish model
  console.log('\n=== Step 6: Reloading TTS with Spanish model ===')
  await model.reload({
    mainModelUrl: `./models/tts/${SPANISH_MODEL}.onnx`,
    configJsonPath: `./models/tts/${SPANISH_MODEL}.onnx.json`,
    language: 'es'
  })
  console.log('Model reloaded with Spanish configuration')

  // Step 7: Run TTS in Spanish
  console.log('\n=== Step 7: Running TTS in Spanish ===')
  const spanishText = 'Hola mundo! Esta es una prueba del sistema de texto a voz.'
  const spanishExpectation = {
    minDurationMs: 2000,
    maxDurationMs: 8000,
    minSamples: 44000,
    maxSamples: 176000
  }

  const spanishResult = await runTTS(model, { text: spanishText }, spanishExpectation)
  console.log(`Spanish TTS result: ${spanishResult.output}`)
  t.ok(spanishResult.passed, 'Spanish TTS should pass expectations')
  t.ok(spanishResult.data.sampleCount > 0, 'Spanish TTS should produce audio samples')
  console.log(`Spanish TTS produced ${spanishResult.data.sampleCount} samples`)

  // Step 8: Unload the model
  console.log('\n=== Step 8: Unloading model ===')
  await model.unload()
  console.log('Model unloaded successfully')
  t.pass('Model unloaded')

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('RELOAD MODEL TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`English TTS: ${englishResult.data.sampleCount} samples, ${englishResult.data.durationMs?.toFixed(0) || 'N/A'}ms`)
  console.log(`Spanish TTS: ${spanishResult.data.sampleCount} samples, ${spanishResult.data.durationMs?.toFixed(0) || 'N/A'}ms`)
  console.log('='.repeat(60))
})
