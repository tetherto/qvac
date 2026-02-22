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
  readFileChunked
} = require('./helpers.js')

const platform = detectPlatform()
const { modelPath, samplesDir } = getTestPaths()

/**
 * Test transcription using individual file paths instead of directory-based loading.
 * The C++ addon loads ONNX sessions directly from the provided file paths,
 * bypassing the buffer-based weight streaming used by directory loading.
 */
test('Transcription via individual file paths', { timeout: 300000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('INDIVIDUAL FILE PATHS TRANSCRIPTION TEST')
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

  const expectedText = 'Alice was beginning to get very tired of sitting by her sister on the bank and of having nothing to do. Once or twice she had peeped into the book her sister was reading, but it had no pictures or conversations in it. And what is the use of a book thought Alice without pictures or conversations'

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

  const transcriptions = []
  let outputResolve = null
  const outputPromise = new Promise(resolve => { outputResolve = resolve })

  function outputCallback (handle, event, id, output, error) {
    if (event === 'Output' && Array.isArray(output)) {
      for (const segment of output) {
        if (segment && segment.text) {
          transcriptions.push(segment)
        }
      }
      if (transcriptions.length > 0 && outputResolve) {
        outputResolve()
        outputResolve = null
      }
    }
  }

  let parakeet = null

  try {
    console.log('=== Creating instance with individual file paths ===')
    console.log(`   encoderPath: ${encoderPath}`)
    console.log(`   encoderDataPath: ${encoderDataPath}`)
    console.log(`   decoderPath: ${decoderPath}`)
    console.log(`   vocabPath: ${vocabPath}`)
    console.log(`   preprocessorPath: ${preprocessorPath}`)

    parakeet = new ParakeetInterface(binding, config, outputCallback)

    // With individual file paths, the C++ addon loads sessions directly —
    // no need for loadWeights() buffer streaming.
    await parakeet.activate()
    console.log('   Model activated via individual file paths\n')

    console.log('=== Processing audio ===')
    const rawBuffer = fs.readFileSync(samplePath)
    const pcmData = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
    const audioData = new Float32Array(pcmData.length)
    for (let i = 0; i < pcmData.length; i++) {
      audioData[i] = pcmData[i] / 32768.0
    }
    console.log(`   Audio duration: ${(audioData.length / 16000).toFixed(2)}s`)

    await parakeet.append({ type: 'audio', data: audioData.buffer })
    await parakeet.append({ type: 'end of job' })

    const timeout = setTimeout(() => { if (outputResolve) { outputResolve(); outputResolve = null } }, 600000)
    await outputPromise
    clearTimeout(timeout)

    const fullText = transcriptions.map(s => s.text).join(' ').trim()

    t.ok(transcriptions.length > 0, `Should produce segments (got ${transcriptions.length})`)
    t.ok(fullText.length > 0, `Should produce text (got ${fullText.length} chars)`)

    console.log('\n=== TRANSCRIPTION OUTPUT ===')
    console.log(fullText)
    console.log('=== END TRANSCRIPTION ===\n')

    const werResult = validateAccuracy(expectedText, fullText, 0.3)
    console.log(`>>> Word Error Rate: ${werResult.werPercent}`)
    t.ok(werResult.wer <= 0.3, `WER should be <= 30% (got ${werResult.werPercent})`)

    console.log('\n' + '='.repeat(60))
    console.log('TEST SUMMARY')
    console.log('='.repeat(60))
    console.log(`Segments: ${transcriptions.length}`)
    console.log(`Text length: ${fullText.length} chars`)
    console.log(`WER: ${werResult.werPercent}`)
    console.log('='.repeat(60))
  } finally {
    console.log('\n=== Cleanup ===')
    if (parakeet) {
      try {
        parakeet.destroyInstance()
        console.log('   Instance destroyed')
      } catch (e) {
        console.log('   Instance destroy error:', e.message)
      }
    }
    try {
      loggerBinding.releaseLogger()
      console.log('   Logger released')
    } catch (e) {
      console.log('   Logger release error:', e.message)
    }
  }
})

/**
 * Test that directory-based loading and individual file path loading
 * produce equivalent transcription results.
 */
test('Directory vs individual file paths produce equivalent results', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('DIRECTORY vs INDIVIDUAL FILE PATHS EQUIVALENCE TEST')
  console.log('='.repeat(60))

  await ensureModel(modelPath)

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

  // --- Run 1: Directory-based loading ---
  console.log('\n--- Run 1: Directory-based loading ---')
  let directoryText = ''
  {
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

    const config = {
      modelPath,
      modelType: 'tdt',
      maxThreads: 4,
      useGPU: false,
      sampleRate: 16000,
      channels: 1
    }

    const parakeet = new ParakeetInterface(binding, config, outputCallback)

    const modelFiles = [
      'encoder-model.onnx',
      'encoder-model.onnx.data',
      'decoder_joint-model.onnx',
      'vocab.txt',
      'preprocessor.onnx'
    ]

    for (const file of modelFiles) {
      const filePath = path.join(modelPath, file)
      if (fs.existsSync(filePath)) {
        const chunks = []
        for (const buffer of readFileChunked(filePath)) {
          chunks.push(buffer)
        }
        const fullBuffer = Buffer.concat(chunks)
        const chunk = new Uint8Array(fullBuffer.buffer, fullBuffer.byteOffset, fullBuffer.byteLength)
        await parakeet.loadWeights({ filename: file, chunk, completed: true })
      }
    }

    await parakeet.activate()
    console.log('   Model activated (directory-based)')

    await parakeet.append({ type: 'audio', data: audioData.buffer })
    await parakeet.append({ type: 'end of job' })

    const timeout = setTimeout(() => { if (outputResolve) { outputResolve(); outputResolve = null } }, 600000)
    await outputPromise
    clearTimeout(timeout)

    directoryText = transcriptions.map(s => s.text).join(' ').trim()
    console.log(`   Output: "${directoryText.substring(0, 80)}..."`)

    try { parakeet.destroyInstance() } catch (e) {}
  }

  // Small delay between tests
  await new Promise(resolve => setTimeout(resolve, 500))

  // --- Run 2: Individual file paths loading ---
  console.log('\n--- Run 2: Individual file paths loading ---')
  let filePathText = ''
  {
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

    const config = {
      modelPath,
      modelType: 'tdt',
      maxThreads: 4,
      useGPU: false,
      sampleRate: 16000,
      channels: 1,
      encoderPath: path.join(modelPath, 'encoder-model.onnx'),
      encoderDataPath: path.join(modelPath, 'encoder-model.onnx.data'),
      decoderPath: path.join(modelPath, 'decoder_joint-model.onnx'),
      vocabPath: path.join(modelPath, 'vocab.txt'),
      preprocessorPath: path.join(modelPath, 'preprocessor.onnx')
    }

    const parakeet = new ParakeetInterface(binding, config, outputCallback)

    await parakeet.activate()
    console.log('   Model activated (individual file paths)')

    await parakeet.append({ type: 'audio', data: audioData.buffer })
    await parakeet.append({ type: 'end of job' })

    const timeout = setTimeout(() => { if (outputResolve) { outputResolve(); outputResolve = null } }, 600000)
    await outputPromise
    clearTimeout(timeout)

    filePathText = transcriptions.map(s => s.text).join(' ').trim()
    console.log(`   Output: "${filePathText.substring(0, 80)}..."`)

    try { parakeet.destroyInstance() } catch (e) {}
  }

  // --- Compare results ---
  console.log('\n=== Comparison ===')
  t.ok(directoryText.length > 0, 'Directory loading produced text')
  t.ok(filePathText.length > 0, 'File path loading produced text')

  const werResult = validateAccuracy(directoryText, filePathText, 0.05)
  console.log(`   Directory text: "${directoryText.substring(0, 80)}..."`)
  console.log(`   File path text: "${filePathText.substring(0, 80)}..."`)
  console.log(`   WER between methods: ${werResult.werPercent}`)

  t.ok(werResult.wer <= 0.05, `Both methods should produce near-identical output (WER: ${werResult.werPercent})`)

  try { loggerBinding.releaseLogger() } catch (e) {}
  console.log('\n✅ Equivalence test completed!\n')
})
