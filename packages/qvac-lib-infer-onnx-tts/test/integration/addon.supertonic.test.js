'use strict'

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const { loadTTS, runTTS } = require('../utils/runTTS')
const { loadWhisper, runWhisper } = require('../utils/runWhisper')
const { ensureSupertonicModels, ensureWhisperModel } = require('../utils/downloadModel')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'
/** Run WER tests only when not on mobile */
const shouldRunWhisper = !isMobile

/** Supertonic output sample rate (Hz) */
const SUPERTONIC_SAMPLE_RATE = 44100

// Returns base directory for models - uses global.testDir on mobile, current dir otherwise
function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

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
    language: 'en'
  }

  // Load model
  console.log('\n=== Loading Supertonic TTS model ===')
  const model = await loadTTS(modelParams)
  t.ok(model, 'Supertonic TTS model should be loaded')
  t.ok(model.addon, 'Addon should be created')

  // Run synthesis
  console.log('\n=== Running Supertonic TTS synthesis ===')
  const text = 'Hello world! This is a test of the Supertonic text to speech system.'

  const expectation = {
    minSamples: 10000,
    maxSamples: 500000,
    minDurationMs: 400,
    maxDurationMs: 20000
  }

  const result = await runTTS(model, { text, saveWav: true, wavOutputPath: path.join(__dirname, '../output/supertonic-test.wav') }, expectation)
  console.log(result.output)

  t.ok(result.passed, 'Supertonic TTS synthesis should pass expectations')
  t.ok(result.data.sampleCount > 0, 'Supertonic TTS should produce audio samples')
  t.is(SUPERTONIC_SAMPLE_RATE, 44100, 'Supertonic output sample rate is 44.1kHz')

  if (result.data?.stats) {
    console.log(`Inference stats: ${JSON.stringify(result.data.stats)}`)
  }

  // Unload model
  console.log('\n=== Unloading Supertonic TTS model ===')
  await model.unload()
  t.pass('Model unloaded successfully')

  // Summary
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
  console.log('\n=== Loading Supertonic TTS model ===')
  const model = await loadTTS(modelParams)
  t.ok(model, 'Supertonic TTS model should be loaded')

  const results = []

  // Run TTS for each text sample
  for (let i = 0; i < dataset.length; i++) {
    const text = dataset[i]
    console.log(`\n--- Supertonic TTS ${i + 1}/${dataset.length}: "${text}" ---`)

    const result = await runTTS(model, { text }, expectation)
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

  // Unload model
  await model.unload()
  console.log('\nSupertonic TTS model unloaded')

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('SUPERTONIC MULTIPLE SENTENCES TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`Total sentences: ${dataset.length}`)
  for (let i = 0; i < results.length; i++) {
    const rtf = results[i].stats?.realTimeFactor ?? 'N/A'
    console.log(`  ${i + 1}. "${results[i].text.substring(0, 40)}..." - ${results[i].sampleCount} samples, ${results[i].durationMs?.toFixed(0) || 'N/A'}ms, RTF: ${rtf}`)
  }
  console.log('='.repeat(60))
})

test('Supertonic TTS: Model loads and synthesis runs with default config', { timeout: 900000 }, async (t) => {
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
    language: 'en'
  }

  console.log('\n=== Testing Supertonic load and synthesis ===')

  let model
  try {
    model = await loadTTS(modelParams)
    t.ok(model, 'Model loaded successfully')
  } catch (err) {
    t.fail(`Failed to load model: ${err.message}`)
    return
  }

  const result = await runTTS(model, { text: 'Test.' }, {})

  if (result.passed && result.data.sampleCount > 0) {
    t.pass('Synthesis succeeded')
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

/** Max WER allowed for Supertonic TTS + Whisper round-trip (fail if WER > 0.3) */
const WER_THRESHOLD = 0.3

test('Supertonic TTS: WER test (TTS + Whisper)', { timeout: 1800000 }, async (t) => {
  if (!shouldRunWhisper) {
    t.skip('WER test skipped on mobile')
    return
  }

  const baseDir = getBaseDir()
  const modelDir = path.join(baseDir, 'models', 'supertonic')
  const whisperPath = path.join(baseDir, 'models', 'whisper', 'ggml-medium.bin')

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
  const modelParams = { modelDir, voiceName: 'F1', language: 'en' }

  console.log('\n=== Loading Supertonic TTS and running synthesis ===')
  const ttsModel = await loadTTS(modelParams)
  t.ok(ttsModel, 'Supertonic TTS model should be loaded')

  const ttsResult = await runTTS(ttsModel, { text }, {})
  t.ok(ttsResult.passed && ttsResult.data?.wavBuffer, 'TTS should produce WAV')
  await ttsModel.unload()

  if (!ttsResult.data?.wavBuffer) {
    t.fail('No WAV buffer for Whisper')
    return
  }

  console.log('\n=== Loading Whisper and transcribing ===')
  const whisperModel = await loadWhisper({
    modelName: 'ggml-medium.bin',
    diskPath: path.join(baseDir, 'models', 'whisper'),
    language: 'en'
  })
  t.ok(whisperModel, 'Whisper model should be loaded')

  const { wer } = await runWhisper(whisperModel, text, ttsResult.data.wavBuffer)
  const werPct = (wer * 100).toFixed(1)

  t.ok(wer <= WER_THRESHOLD, `WER should be <= ${WER_THRESHOLD * 100}%, got ${werPct}%`)
  if (wer > WER_THRESHOLD) {
    console.log(`WER test failed: ${werPct}% > ${WER_THRESHOLD * 100}%`)
  } else {
    console.log(`WER test passed: ${werPct}% <= ${WER_THRESHOLD * 100}%`)
  }
})
