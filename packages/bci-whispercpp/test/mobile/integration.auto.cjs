'use strict'
require('./integration-runtime.cjs')

const BCIWhispercpp = require('../../index')

function getAssetPath (filename) {
  if (global.assetPaths) {
    const key = `../../testAssets/${filename}`
    if (global.assetPaths[key]) {
      return global.assetPaths[key].replace('file://', '')
    }
    throw new Error(`Asset not found: ${filename}. Ensure it is in test/mobile/testAssets/`)
  }
  const path = require('bare-path')
  return path.join(__dirname, 'testAssets', filename)
}

async function runLoadAndDestroyTest (options = {}) { // eslint-disable-line no-unused-vars
  const result = { summary: { total: 1, passed: 0, failed: 0 }, output: '' }
  try {
    const modelPath = getAssetPath('ggml-bci-windowed.bin')
    const bci = new BCIWhispercpp({ modelPath }, {
      whisperConfig: { language: 'en', temperature: 0.0 },
      miscConfig: { caption_enabled: false }
    })

    await bci.load()
    await bci.destroy()

    result.summary.passed = 1
    result.output = 'Model loaded and destroyed successfully'
    console.log('[BCI] Load and destroy: PASS')
  } catch (err) {
    result.summary.failed = 1
    result.output = err.message || String(err)
    console.error('[BCI] Load and destroy: FAIL -', result.output)
  }
  return result
}

async function runTranscriptionTest (options = {}) { // eslint-disable-line no-unused-vars
  const result = { summary: { total: 1, passed: 0, failed: 0 }, output: '' }
  try {
    const modelPath = getAssetPath('ggml-bci-windowed.bin')
    const samplePath = getAssetPath('neural_sample_2.bin')

    const bci = new BCIWhispercpp({ modelPath }, {
      whisperConfig: { language: 'en', temperature: 0.0 },
      miscConfig: { caption_enabled: false }
    })

    await bci.load()
    const transcription = await bci.transcribeFile(samplePath)
    await bci.destroy()

    const text = transcription.text || ''
    console.log(`[BCI] Transcription result: "${text}"`)

    if (typeof text === 'string' && text.length > 0) {
      result.summary.passed = 1
      result.output = `Transcribed: "${text}"`
      console.log('[BCI] Transcription: PASS')
    } else {
      result.summary.failed = 1
      result.output = 'Empty transcription result'
      console.error('[BCI] Transcription: FAIL - empty result')
    }
  } catch (err) {
    result.summary.failed = 1
    result.output = err.message || String(err)
    console.error('[BCI] Transcription: FAIL -', result.output)
  }
  return result
}
