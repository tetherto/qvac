'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const {
  binding,
  ParakeetInterface,
  detectPlatform,
  setupJsLogger,
  getTestPaths,
  validateAccuracy,
  ensureModel
} = require('./helpers.js')

const platform = detectPlatform()
const { modelPath, samplesDir } = getTestPaths()

const expectedText = 'Alice was beginning to get very tired of sitting by her sister on the bank and of having nothing to do. Once or twice she had peeped into the book her sister was reading, but it had no pictures or conversations in it. And what is the use of a book thought Alice without pictures or conversations'

/**
 * Validates that models with external data files (.onnx.data) load correctly
 * via the staging mechanism (symlink → hardlink → copy fallback).
 *
 * This is the scenario that failed on Windows when users lacked
 * SeCreateSymbolicLinkPrivilege — the fix adds hardlink/copy fallback.
 */
test('External data staging: TDT model loads with encoderPath + encoderDataPath', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('EXTERNAL DATA STAGING TEST (symlink/hardlink/copy fallback)')
  console.log('='.repeat(60))
  console.log(` Platform: ${platform}`)
  console.log(` Model path: ${modelPath}`)
  console.log('='.repeat(60) + '\n')

  await ensureModel(modelPath)

  const encoderPath = path.join(modelPath, 'encoder-model.onnx')
  const encoderDataPath = path.join(modelPath, 'encoder-model.onnx.data')
  const decoderPath = path.join(modelPath, 'decoder_joint-model.onnx')
  const vocabPath = path.join(modelPath, 'vocab.txt')
  const preprocessorPath = path.join(modelPath, 'preprocessor.onnx')

  t.ok(fs.existsSync(encoderPath), 'encoder-model.onnx exists')
  t.ok(fs.existsSync(encoderDataPath), 'encoder-model.onnx.data exists (external data)')
  t.ok(fs.existsSync(decoderPath), 'decoder_joint-model.onnx exists')
  t.ok(fs.existsSync(vocabPath), 'vocab.txt exists')
  t.ok(fs.existsSync(preprocessorPath), 'preprocessor.onnx exists')

  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) {
    loggerBinding.releaseLogger()
    t.pass('Test skipped - sample audio not found')
    return
  }

  const rawBuffer = fs.readFileSync(samplePath)
  const pcmData = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
  const audioData = new Float32Array(pcmData.length)
  for (let i = 0; i < pcmData.length; i++) {
    audioData[i] = pcmData[i] / 32768.0
  }
  console.log(`Audio duration: ${(audioData.length / 16000).toFixed(2)}s\n`)

  const transcriptions = []
  let outputResolve = null
  const outputPromise = new Promise(resolve => { outputResolve = resolve })

  function outputCallback (handle, event, id, output, error) {
    if (event === 'Output' && Array.isArray(output)) {
      for (const segment of output) {
        if (segment && segment.text) transcriptions.push(segment)
      }
    }
    if ((event === 'JobEnded' || event === 'Error') && outputResolve) {
      outputResolve()
      outputResolve = null
    }
  }

  // Use individual file paths — this triggers the staging code path
  // in loadTDTSessions when encoderDataPath is present
  const config = {
    modelPath,
    modelType: 'tdt',
    maxThreads: 4,
    useGPU: false,
    sampleRate: 16000,
    channels: 1,
    encoderPath,
    encoderDataPath,
    decoderPath,
    vocabPath,
    preprocessorPath
  }

  console.log('=== Loading model with external data (staging path) ===')
  const parakeet = new ParakeetInterface(binding, config, outputCallback)

  await parakeet.activate()
  console.log('   Model activated successfully (staging worked)')
  t.pass('Model activation with external data should succeed')

  await parakeet.append({ type: 'audio', data: audioData.buffer })
  await parakeet.append({ type: 'end of job' })

  const timeout = setTimeout(() => { if (outputResolve) { outputResolve(); outputResolve = null } }, 300000)
  await outputPromise
  clearTimeout(timeout)

  const fullText = transcriptions.map(s => s.text).join(' ').trim()
  console.log(`   Transcription: "${fullText.substring(0, 80)}..."`)

  t.ok(transcriptions.length > 0, `Should produce segments (got ${transcriptions.length})`)
  t.ok(fullText.length > 0, `Should produce text (got ${fullText.length} chars)`)

  const werResult = validateAccuracy(expectedText, fullText, 0.3)
  console.log(`   WER: ${werResult.werPercent}`)
  t.ok(werResult.wer <= 0.3, `WER should be <= 30% (got ${werResult.werPercent})`)

  try { await parakeet.destroyInstance() } catch (e) {}
  console.log('   Instance destroyed')

  console.log('\n' + '='.repeat(60))
  console.log('EXTERNAL DATA STAGING TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`  Segments: ${transcriptions.length}`)
  console.log(`  Text length: ${fullText.length} chars`)
  console.log(`  WER: ${werResult.werPercent}`)
  console.log('  Result: PASS')
  console.log('='.repeat(60) + '\n')

  try { loggerBinding.releaseLogger() } catch (e) {}
})
