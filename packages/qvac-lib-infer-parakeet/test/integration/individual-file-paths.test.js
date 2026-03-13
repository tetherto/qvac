'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const binding = require('../../binding')
const { ParakeetInterface } = require('../../parakeet')
const {
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
 * Verify that explicit individual file paths produce correct transcriptions.
 * All model types now require named paths — C++ loads directly from disk.
 */
test('Individual file paths produce correct transcription', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('INDIVIDUAL FILE PATHS TEST')
  console.log('='.repeat(60))
  console.log(` Platform: ${platform}`)
  console.log(` Model path: ${modelPath}`)
  console.log('='.repeat(60) + '\n')

  await ensureModel(modelPath)

  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) {
    loggerBinding.releaseLogger()
    t.pass('Test skipped - sample audio not found')
    return
  }

  const encoderPath = path.join(modelPath, 'encoder-model.onnx')
  const encoderDataPath = path.join(modelPath, 'encoder-model.onnx.data')
  const decoderPath = path.join(modelPath, 'decoder_joint-model.onnx')
  const vocabPath = path.join(modelPath, 'vocab.txt')
  const preprocessorPath = path.join(modelPath, 'preprocessor.onnx')

  for (const p of [encoderPath, decoderPath, vocabPath, preprocessorPath]) {
    t.ok(fs.existsSync(p), `Required file exists: ${path.basename(p)}`)
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
      if (transcriptions.length > 0 && outputResolve) {
        outputResolve()
        outputResolve = null
      }
    }
  }

  console.log(`  encoderPath:      ${encoderPath}`)
  console.log(`  encoderDataPath:  ${encoderDataPath}`)
  console.log(`  decoderPath:      ${decoderPath}`)
  console.log(`  vocabPath:        ${vocabPath}`)
  console.log(`  preprocessorPath: ${preprocessorPath}\n`)

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

  let parakeet = null

  try {
    parakeet = new ParakeetInterface(binding, config, outputCallback)

    await parakeet.activate()
    console.log('  Model activated\n')

    await parakeet.append({ type: 'audio', data: audioData.buffer })
    await parakeet.append({ type: 'end of job' })

    const timeout = setTimeout(() => { if (outputResolve) { outputResolve(); outputResolve = null } }, 600000)
    await outputPromise
    clearTimeout(timeout)

    const fullText = transcriptions.map(s => s.text).join(' ').trim()
    console.log(`  Text: "${fullText.substring(0, 100)}..."`)

    t.ok(transcriptions.length > 0, `Should produce segments (got ${transcriptions.length})`)
    t.ok(fullText.length > 0, `Should produce text (got ${fullText.length} chars)`)

    const werResult = validateAccuracy(expectedText, fullText, 0.3)
    console.log(`  WER: ${werResult.werPercent}`)
    t.ok(werResult.wer <= 0.3, `WER should be <= 30% (got ${werResult.werPercent})`)

    console.log('\n' + '='.repeat(60))
    console.log('TEST SUMMARY')
    console.log('='.repeat(60))
    console.log(`  Segments: ${transcriptions.length}`)
    console.log(`  Text length: ${fullText.length} chars`)
    console.log(`  WER: ${werResult.werPercent}`)
    console.log('='.repeat(60) + '\n')
  } finally {
    if (parakeet) {
      try { parakeet.destroyInstance() } catch (e) {}
    }
    try { loggerBinding.releaseLogger() } catch (e) {}
  }
})
