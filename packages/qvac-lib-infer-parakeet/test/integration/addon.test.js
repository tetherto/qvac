'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const test = require('brittle')
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

test('English transcription and WER verification', { timeout: 300000 }, async (t) => {
  // Setup logger inside test
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('PARAKEET TRANSCRIPTION TEST')
  console.log('='.repeat(60))
  console.log(` Platform: ${platform}`)
  console.log(` Model path: ${modelPath}`)

  // Ensure model is downloaded (downloads if not present)
  await ensureModel(modelPath)

  const requiredFiles = [
    'encoder-model.onnx',
    'decoder_joint-model.onnx',
    'vocab.txt',
    'preprocessor.onnx'
  ]

  for (const file of requiredFiles) {
    const filePath = path.join(modelPath, file)
    t.ok(fs.existsSync(filePath), `Required file exists: ${file}`)
  }

  // Check sample audio exists
  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) {
    loggerBinding.releaseLogger()
    t.fail(`Sample audio not found: ${samplePath}`)
    return
  }

  // Expected transcription (Alice in Wonderland excerpt)
  const expectedText = 'Alice was beginning to get very tired of sitting by her sister on the bank and of having nothing to do. Once or twice she had peeped into the book her sister was reading, but it had no pictures or conversations in it. And what is the use of a book thought Alice without pictures or conversations'

  // Configuration
  const config = {
    modelPath,
    modelType: 'tdt',
    maxThreads: 4,
    useGPU: false,
    sampleRate: 16000,
    channels: 1
  }

  // Track transcription results
  const transcriptions = []
  let outputResolve = null
  const outputPromise = new Promise(resolve => { outputResolve = resolve })

  // Output callback - resolve when we receive actual transcription output
  function outputCallback (handle, event, id, output, error) {
    if (event === 'Output' && Array.isArray(output)) {
      for (const segment of output) {
        if (segment && segment.text) {
          transcriptions.push(segment)
        }
      }
      // Resolve when we get actual output (transcription completed)
      if (transcriptions.length > 0 && outputResolve) {
        outputResolve()
        outputResolve = null
      }
    }
  }

  let parakeet = null

  try {
    console.log('\n=== Creating instance and loading model ===')
    parakeet = new ParakeetInterface(binding, config, outputCallback)

    // Load model weights
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
        const stat = fs.statSync(filePath)
        const fileSize = stat.size

        // Read file in chunks to handle bare-fs large file limitations,
        // then concatenate and pass as single buffer for reliable native loading
        const chunks = []
        for (const buffer of readFileChunked(filePath)) {
          chunks.push(buffer)
        }
        const fullBuffer = Buffer.concat(chunks)
        const chunk = new Uint8Array(fullBuffer.buffer, fullBuffer.byteOffset, fullBuffer.byteLength)
        await parakeet.loadWeights({ filename: file, chunk, completed: true })
        console.log(`   Loaded ${file} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`)
      }
    }

    // Activate
    await parakeet.activate()
    console.log('   Model activated')

    // Load and convert audio
    console.log('\n=== Processing audio ===')
    console.log(`   Audio file: ${samplePath}`)

    const rawBuffer = fs.readFileSync(samplePath)
    const pcmData = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
    const audioData = new Float32Array(pcmData.length)
    for (let i = 0; i < pcmData.length; i++) {
      audioData[i] = pcmData[i] / 32768.0
    }
    console.log(`   Audio duration: ${(audioData.length / 16000).toFixed(2)}s`)

    // Transcribe
    await parakeet.append({ type: 'audio', data: audioData.buffer })
    await parakeet.append({ type: 'end of job' })

    // Wait for transcription output (120s timeout for CI runners which are slower)
    const timeout = setTimeout(() => { if (outputResolve) { outputResolve(); outputResolve = null } }, 600000)
    await outputPromise
    clearTimeout(timeout)

    // Get results
    const fullText = transcriptions.map(s => s.text).join(' ').trim()

    t.ok(transcriptions.length > 0, `Should produce segments (got ${transcriptions.length})`)
    t.ok(fullText.length > 0, `Should produce text (got ${fullText.length} chars)`)

    console.log('\n=== TRANSCRIPTION OUTPUT ===')
    console.log(fullText)
    console.log('=== END TRANSCRIPTION ===\n')

    // WER verification
    console.log('=== WER Verification ===')
    const werResult = validateAccuracy(expectedText, fullText, 0.3)

    console.log(`Expected: "${expectedText.substring(0, 100)}..."`)
    console.log(`Got:      "${fullText.substring(0, 100)}..."`)
    console.log(`>>> Word Error Rate: ${werResult.werPercent}`)

    t.ok(werResult.wer <= 0.3, `WER should be <= 30% (got ${werResult.werPercent})`)

    // Summary
    console.log('\n' + '='.repeat(60))
    console.log('TEST SUMMARY')
    console.log('='.repeat(60))
    console.log(`Segments: ${transcriptions.length}`)
    console.log(`Text length: ${fullText.length} chars`)
    console.log(`WER: ${werResult.werPercent}`)
    console.log(`WER verification: ${werResult.passed ? 'PASSED' : 'FAILED'}`)
    console.log('='.repeat(60))
  } finally {
    // Cleanup
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
