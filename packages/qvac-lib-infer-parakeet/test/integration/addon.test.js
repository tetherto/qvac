'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const test = require('brittle')
const binding = require('../../binding')
const { ParakeetInterface } = require('../../parakeet')
const {
  detectPlatform,
  setupJsLogger,
  waitUntilIdle,
  getTestPaths,
  validateAccuracy,
  ensureModel,
  getNamedPathsConfig
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
    channels: 1,
    ...getNamedPathsConfig('tdt', modelPath)
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
    }
    if ((event === 'JobEnded' || event === 'Error') && outputResolve) {
      outputResolve()
      outputResolve = null
    }
  }

  let parakeet = null

  try {
    console.log('\n=== Creating instance and loading model ===')
    parakeet = new ParakeetInterface(binding, config, outputCallback)

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
        await waitUntilIdle(parakeet, 60000)
        await parakeet.destroyInstance()
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

test('Cancel active job keeps model usable for next job', { timeout: 600000, skip: !platform.startsWith('darwin') }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  await ensureModel(modelPath)

  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) {
    loggerBinding.releaseLogger()
    t.fail(`Required audio file not found: ${samplePath}`)
    return
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

  const outputsByJob = new Map()
  const resolvers = new Map()
  const waitForJob = (jobId, timeoutMs = 180000, errorGraceMs = 5000) => new Promise((resolve) => {
    let pendingError = null
    let errorGraceTimeout = null

    const finish = (event, error) => {
      clearTimeout(timeout)
      if (errorGraceTimeout) clearTimeout(errorGraceTimeout)
      resolvers.delete(jobId)
      resolve({ event, error: error || null })
    }

    const timeout = setTimeout(() => {
      finish('Timeout', null)
    }, timeoutMs)

    resolvers.set(jobId, (event, error) => {
      // Cancellation is cooperative, and the shared addon-cpp queue can emit a
      // late terminal Error for the cancelled job shortly after the next job is
      // accepted. Give that transient Error a short grace window before
      // treating it as terminal so a subsequent JobEnded can win.
      if (event === 'Error') {
        pendingError = error || null
        if (!errorGraceTimeout) {
          errorGraceTimeout = setTimeout(() => {
            finish('Error', pendingError)
          }, errorGraceMs)
        }
        return
      }

      finish(event, error)
    })
  })

  async function submitJobWhenReady (audioBuffer, timeoutMs = 180000, retryDelayMs = 1000) {
    const deadline = Date.now() + timeoutMs
    let buffered = false
    let lastBusyError = null

    while (Date.now() < deadline) {
      if (!buffered) {
        await parakeet.append({ type: 'audio', data: audioBuffer })
        buffered = true
      }

      try {
        return await parakeet.append({ type: 'end of job' })
      } catch (error) {
        const message = error?.message || ''
        const causeMessage = error?.cause?.message || ''
        const isBusy =
          message.includes('Cannot set new job: a job is already set or being processed') ||
          causeMessage.includes('Cannot set new job: a job is already set or being processed')

        if (!isBusy) {
          throw error
        }

        lastBusyError = error
        await new Promise(resolve => setTimeout(resolve, retryDelayMs))
      }
    }

    throw lastBusyError || new Error('Timed out waiting for the model to accept the next job')
  }

  function toFloat32Audio (rawBuffer) {
    const pcmData = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
    const audioData = new Float32Array(pcmData.length)
    for (let i = 0; i < pcmData.length; i++) {
      audioData[i] = pcmData[i] / 32768.0
    }
    return audioData
  }

  function outputCallback (handle, event, id, output, error) {
    if (event === 'Output' && Array.isArray(output)) {
      if (!outputsByJob.has(id)) outputsByJob.set(id, [])
      for (const segment of output) {
        if (segment && segment.text) {
          outputsByJob.get(id).push(segment)
        }
      }
    }
    if ((event === 'JobEnded' || event === 'Error') && resolvers.has(id)) {
      const resolve = resolvers.get(id)
      resolvers.delete(id)
      resolve(event, error)
    }
  }

  let parakeet = null
  try {
    parakeet = new ParakeetInterface(binding, config, outputCallback)

    await parakeet.activate()

    const shortAudio = toFloat32Audio(fs.readFileSync(samplePath))

    // Start a job and cancel it immediately.
    await parakeet.append({ type: 'audio', data: shortAudio.buffer })
    const firstJobId = await parakeet.append({ type: 'end of job' })
    await parakeet.cancel(firstJobId)

    const statusAfterCancel = await parakeet.status()
    t.ok(statusAfterCancel === 'listening', `Status should return to listening after cancel (got ${statusAfterCancel})`)

    // Ensure model still accepts and completes the next job.
    // Cancellation is cooperative, and some slower runners can briefly keep the
    // native worker busy even after JS-side state returns to listening.
    const secondJobId = await submitJobWhenReady(shortAudio.buffer)

    const secondJobResult = await waitForJob(secondJobId)

    t.ok(secondJobId > firstJobId, `Second job id should increment (first=${firstJobId}, second=${secondJobId})`)
    t.ok(secondJobResult.event === 'JobEnded', `Second job should finish successfully (got ${secondJobResult.event})`)

    const secondSegments = outputsByJob.get(secondJobId) || []
    const secondText = secondSegments.map(s => s.text).join(' ').trim()
    t.ok(secondSegments.length > 0, `Second job should produce output segments (got ${secondSegments.length})`)
    t.ok(secondText.length > 0, `Second job should produce non-empty text (got ${secondText.length} chars)`)
  } finally {
    if (parakeet) {
      try {
        await waitUntilIdle(parakeet, 60000)
        await parakeet.destroyInstance()
      } catch {}
    }
    try {
      loggerBinding.releaseLogger()
    } catch {}
  }
})
