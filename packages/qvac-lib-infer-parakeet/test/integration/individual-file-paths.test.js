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
  ensureModel,
  getNamedPathsConfig
} = require('./helpers.js')

const platform = detectPlatform()
const { modelPath, samplesDir } = getTestPaths()

const expectedText = 'Alice was beginning to get very tired of sitting by her sister on the bank and of having nothing to do. Once or twice she had peeped into the book her sister was reading, but it had no pictures or conversations in it. And what is the use of a book thought Alice without pictures or conversations'

/**
 * Test both directory-based and individual file path loading methods,
 * verifying each produces correct transcription output and that both
 * methods yield equivalent results.
 */
test('Directory and individual file path loading both produce correct transcriptions', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('DIRECTORY vs INDIVIDUAL FILE PATHS TEST')
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

  let directoryText = ''
  let filePathText = ''

  // Run 1: directory-based loading
  console.log('=== Run 1: Directory-based loading ===')
  {
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

    const config = {
      modelPath,
      modelType: 'tdt',
      maxThreads: 4,
      useGPU: false,
      sampleRate: 16000,
      channels: 1,
      ...getNamedPathsConfig('tdt', modelPath)
    }

    const parakeet = new ParakeetInterface(binding, config, outputCallback)

    await parakeet.activate()
    console.log('   Model activated (directory-based)')

    await parakeet.append({ type: 'audio', data: audioData.buffer })
    await parakeet.append({ type: 'end of job' })

    const timeout = setTimeout(() => { if (outputResolve) { outputResolve(); outputResolve = null } }, 600000)
    await outputPromise
    clearTimeout(timeout)

    directoryText = transcriptions.map(s => s.text).join(' ').trim()
    console.log(`   Text: "${directoryText.substring(0, 80)}..."`)

    t.ok(transcriptions.length > 0, `Directory: should produce segments (got ${transcriptions.length})`)
    t.ok(directoryText.length > 0, `Directory: should produce text (got ${directoryText.length} chars)`)

    const werResult = validateAccuracy(expectedText, directoryText, 0.3)
    console.log(`   WER: ${werResult.werPercent}`)
    t.ok(werResult.wer <= 0.3, `Directory: WER should be <= 30% (got ${werResult.werPercent})`)

    try { await parakeet.destroyInstance() } catch (e) {}
    console.log('   Instance destroyed\n')
  }

  await new Promise(resolve => setTimeout(resolve, 1000))

  // Run 2: individual file path loading
  console.log('=== Run 2: Individual file paths loading ===')
  console.log(`   encoderPath: ${encoderPath}`)
  console.log(`   encoderDataPath: ${encoderDataPath}`)
  console.log(`   decoderPath: ${decoderPath}`)
  console.log(`   vocabPath: ${vocabPath}`)
  console.log(`   preprocessorPath: ${preprocessorPath}`)
  {
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

    const parakeet = new ParakeetInterface(binding, config, outputCallback)

    // No loadWeights() needed — C++ addon loads directly from file paths
    await parakeet.activate()
    console.log('   Model activated (individual file paths)')

    await parakeet.append({ type: 'audio', data: audioData.buffer })
    await parakeet.append({ type: 'end of job' })

    const timeout = setTimeout(() => { if (outputResolve) { outputResolve(); outputResolve = null } }, 600000)
    await outputPromise
    clearTimeout(timeout)

    filePathText = transcriptions.map(s => s.text).join(' ').trim()
    console.log(`   Text: "${filePathText.substring(0, 80)}..."`)

    t.ok(transcriptions.length > 0, `File paths: should produce segments (got ${transcriptions.length})`)
    t.ok(filePathText.length > 0, `File paths: should produce text (got ${filePathText.length} chars)`)

    const werResult = validateAccuracy(expectedText, filePathText, 0.3)
    console.log(`   WER: ${werResult.werPercent}`)
    t.ok(werResult.wer <= 0.3, `File paths: WER should be <= 30% (got ${werResult.werPercent})`)

    try { await parakeet.destroyInstance() } catch (e) {}
    console.log('   Instance destroyed\n')
  }

  console.log('=== Comparison ===')
  const werBetween = validateAccuracy(directoryText, filePathText, 0.05)
  console.log(`   Directory:   "${directoryText.substring(0, 80)}..."`)
  console.log(`   File paths:  "${filePathText.substring(0, 80)}..."`)
  console.log(`   WER between: ${werBetween.werPercent}`)

  t.ok(werBetween.wer <= 0.05, `Both methods should produce near-identical output (WER: ${werBetween.werPercent})`)

  console.log('\n' + '='.repeat(60))
  console.log('TEST SUMMARY')
  console.log('='.repeat(60))
  console.log(`  Directory:      ${directoryText.length} chars, WER ${validateAccuracy(expectedText, directoryText, 0.3).werPercent}`)
  console.log(`  File paths:     ${filePathText.length} chars, WER ${validateAccuracy(expectedText, filePathText, 0.3).werPercent}`)
  console.log(`  Cross-method:   WER ${werBetween.werPercent}`)
  console.log('='.repeat(60) + '\n')

  try { loggerBinding.releaseLogger() } catch (e) {}
})
