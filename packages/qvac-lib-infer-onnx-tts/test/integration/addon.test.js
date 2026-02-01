'use strict'

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const { loadTTS, runTTS } = require('../utils/runTTS')
const { loadWhisper, runWhisper } = require('../utils/runWhisper')
const { ensureTTSModelPair, ensureEspeakData, ensureWhisperModel } = require('../utils/downloadModel')

const platform = os.platform()
const isLinux = platform === 'linux'
const isMobile = platform === 'ios' || platform === 'android'
const shouldRunWhisper = !isLinux && !isMobile

// Returns base directory for models - uses global.testDir on mobile, current dir otherwise
function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

// Helper to get model paths
function getModelPaths () {
  const baseDir = getBaseDir()
  return {
    ttsDir: path.join(baseDir, 'models', 'tts'),
    whisperDir: path.join(baseDir, 'models', 'whisper')
  }
}

test('English TTS synthesis and WER verification', { timeout: 1200000 }, async (t) => {
  const { ttsDir, whisperDir } = getModelPaths()

  // Ensure espeak-ng-data is available
  console.log('\n=== Ensuring espeak-ng-data ===')
  const espeakResult = await ensureEspeakData(path.join(ttsDir, 'espeak-ng-data'))
  t.ok(espeakResult.success, 'espeak-ng-data should be available')

  // Ensure Whisper model if needed
  if (shouldRunWhisper) {
    console.log('\n=== Ensuring Whisper model ===')
    await ensureWhisperModel(path.join(whisperDir, 'ggml-small.bin'))
  }

  // Ensure English TTS model
  console.log('\n=== Ensuring English TTS model ===')
  const modelResult = await ensureTTSModelPair('en_US-lessac-medium')
  t.ok(modelResult.success, 'English TTS model should be downloaded')
  if (!modelResult.success) return

  const modelParams = {
    mainModelUrl: path.join(ttsDir, 'en_US-lessac-medium.onnx'),
    configJsonPath: path.join(ttsDir, 'en_US-lessac-medium.onnx.json'),
    eSpeakDataPath: path.join(ttsDir, 'espeak-ng-data'),
    language: 'en-us'
  }

  const dataset = [
    'The curious cat wandered through the quiet garden at dawn.',
    'A gentle breeze carried the scent of pine across the hillside.',
    'Her voice echoed softly as she called out into the empty hall.',
    'Bright lanterns swayed above the street, filling the night with warm light.'
  ]

  const expectation = {
    minDurationMs: 2500,
    maxDurationMs: 6000,
    minSamples: 60000,
    maxSamples: 132000
  }

  const ttsResults = []

  // Load TTS model
  console.log('\n=== Loading English TTS model ===')
  const model = await loadTTS(modelParams)
  t.ok(model, 'TTS model should be loaded')

  // Run TTS for each text sample
  for (let i = 0; i < dataset.length; i++) {
    const text = dataset[i]
    console.log(`\n--- TTS ${i + 1}/${dataset.length}: "${text}" ---`)

    const result = await runTTS(model, { text }, expectation)
    console.log(result.output)

    t.ok(result.passed, `TTS synthesis ${i + 1} should pass expectations`)
    t.ok(result.data.sampleCount > 0, `TTS synthesis ${i + 1} should produce samples`)

    if (result.data?.stats) {
      console.log(`Inference stats: ${JSON.stringify(result.data.stats)}`)
    }

    const wavBuffer = result.data?.wavBuffer ? Buffer.from(result.data.wavBuffer) : null
    ttsResults.push({ text, wavBuffer })
  }

  // Unload TTS model
  await model.unload()
  console.log('\nTTS model unloaded')

  // Run Whisper WER verification if not on Linux
  if (shouldRunWhisper) {
    console.log('\n=== Loading Whisper model for WER verification ===')
    const whisperParams = {
      modelName: 'ggml-small.bin',
      diskPath: whisperDir,
      language: 'en',
      seed: 0
    }
    const whisperModel = await loadWhisper(whisperParams)
    t.ok(whisperModel, 'Whisper model should be loaded')

    for (let i = 0; i < ttsResults.length; i++) {
      const { text, wavBuffer } = ttsResults[i]
      if (!wavBuffer) continue

      console.log(`\n--- Whisper ${i + 1}/${ttsResults.length}: "${text}" ---`)
      const whisperResult = await runWhisper(whisperModel, text, wavBuffer)
      console.log(`>>> [WHISPER] Word Error Rate: ${whisperResult.wer}`)

      t.ok(whisperResult.wer <= 0.3, `WER ${i + 1} should be <= 0.3 (got ${whisperResult.wer})`)
    }

    await whisperModel.unload()
    console.log('\nWhisper model unloaded')
  } else {
    console.log('\nSkipping Whisper/WER verification (Linux)')
  }

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('ENGLISH TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`Total text samples: ${dataset.length}`)
  console.log(`TTS results collected: ${ttsResults.length}`)
  if (shouldRunWhisper) {
    console.log('WER verification: Completed')
  } else {
    console.log('WER verification: Skipped (Linux)')
  }
  console.log('='.repeat(60))
})

test('Spanish TTS synthesis and WER verification', { timeout: 1200000 }, async (t) => {
  const { ttsDir, whisperDir } = getModelPaths()

  // Ensure espeak-ng-data is available
  console.log('\n=== Ensuring espeak-ng-data ===')
  const espeakResult = await ensureEspeakData(path.join(ttsDir, 'espeak-ng-data'))
  t.ok(espeakResult.success, 'espeak-ng-data should be available')

  // Ensure Whisper model if needed
  if (shouldRunWhisper) {
    console.log('\n=== Ensuring Whisper model ===')
    await ensureWhisperModel(path.join(whisperDir, 'ggml-small.bin'))
  }

  // Ensure Spanish TTS model
  console.log('\n=== Ensuring Spanish TTS model ===')
  const modelResult = await ensureTTSModelPair('es_ES-davefx-medium')
  t.ok(modelResult.success, 'Spanish TTS model should be downloaded')
  if (!modelResult.success) return

  const modelParams = {
    mainModelUrl: path.join(ttsDir, 'es_ES-davefx-medium.onnx'),
    configJsonPath: path.join(ttsDir, 'es_ES-davefx-medium.onnx.json'),
    eSpeakDataPath: path.join(ttsDir, 'espeak-ng-data'),
    language: 'es'
  }

  const dataset = [
    'El gato curioso vagó por el tranquilo jardín al amanecer, observando las flores que comenzaban a abrirse bajo la primera luz del día.',
    'Una suave brisa llevó el aroma de pino a través de la ladera mientras el sol se ocultaba detrás de las montañas en el horizonte.',
    'Su voz resonó suavemente mientras llamaba en el pasillo vacío, esperando una respuesta que nunca llegó desde las habitaciones oscuras.',
    'Los faroles brillantes se mecían sobre la calle, llenando la noche con una luz cálida que iluminaba los rostros de los paseantes.'
  ]

  const expectation = {
    minDurationMs: 5000,
    maxDurationMs: 12000,
    minSamples: 110000,
    maxSamples: 264000
  }

  const ttsResults = []

  // Load TTS model
  console.log('\n=== Loading Spanish TTS model ===')
  const model = await loadTTS(modelParams)
  t.ok(model, 'TTS model should be loaded')

  // Run TTS for each text sample
  for (let i = 0; i < dataset.length; i++) {
    const text = dataset[i]
    console.log(`\n--- TTS ${i + 1}/${dataset.length}: "${text.slice(0, 60)}..." ---`)

    const result = await runTTS(model, { text }, expectation)
    console.log(result.output)

    t.ok(result.passed, `TTS synthesis ${i + 1} should pass expectations`)
    t.ok(result.data.sampleCount > 0, `TTS synthesis ${i + 1} should produce samples`)

    if (result.data?.stats) {
      console.log(`Inference stats: ${JSON.stringify(result.data.stats)}`)
    }

    const wavBuffer = result.data?.wavBuffer ? Buffer.from(result.data.wavBuffer) : null
    ttsResults.push({ text, wavBuffer })
  }

  // Unload TTS model
  await model.unload()
  console.log('\nTTS model unloaded')

  // Run Whisper WER verification if not on Linux
  if (shouldRunWhisper) {
    console.log('\n=== Loading Whisper model for WER verification ===')
    const whisperParams = {
      modelName: 'ggml-small.bin',
      diskPath: whisperDir,
      language: 'es',
      seed: 0
    }
    const whisperModel = await loadWhisper(whisperParams)
    t.ok(whisperModel, 'Whisper model should be loaded')

    for (let i = 0; i < ttsResults.length; i++) {
      const { text, wavBuffer } = ttsResults[i]
      if (!wavBuffer) continue

      console.log(`\n--- Whisper ${i + 1}/${ttsResults.length}: "${text.slice(0, 60)}..." ---`)
      const whisperResult = await runWhisper(whisperModel, text, wavBuffer)
      console.log(`>>> [WHISPER] Word Error Rate: ${whisperResult.wer}`)

      t.ok(whisperResult.wer <= 0.4, `WER ${i + 1} should be <= 0.4 (got ${whisperResult.wer})`)
    }

    await whisperModel.unload()
    console.log('\nWhisper model unloaded')
  } else {
    console.log('\nSkipping Whisper/WER verification (Linux)')
  }

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('SPANISH TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`Total text samples: ${dataset.length}`)
  console.log(`TTS results collected: ${ttsResults.length}`)
  if (shouldRunWhisper) {
    console.log('WER verification: Completed')
  } else {
    console.log('WER verification: Skipped (Linux)')
  }
  console.log('='.repeat(60))
})
