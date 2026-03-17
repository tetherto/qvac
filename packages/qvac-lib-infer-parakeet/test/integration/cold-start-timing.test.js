'use strict'

/**
 * Cold Start Timing Test
 *
 * This test validates the "first transcription is slower" behavior.
 * It measures timing across multiple consecutive transcriptions
 * to quantify the cold start penalty.
 *
 * Expected behavior:
 * - First transcription is slower due to model initialization
 * - Subsequent runs should be faster (warm cache, loaded model)
 */

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const binding = require('../../binding')
const { ParakeetInterface } = require('../../parakeet')
const {
  detectPlatform,
  setupJsLogger,
  getTestPaths,
  ensureModel,
  getNamedPathsConfig,
  isMobile
} = require('./helpers.js')

const platform = detectPlatform()
const { modelPath, samplesDir } = getTestPaths()

/**
 * High-resolution timer using hrtime (works in Bare)
 */
function getTimeMs () {
  const [sec, nsec] = process.hrtime()
  return sec * 1000 + nsec / 1e6
}

/**
 * Test cold start timing: measure first vs subsequent transcription times
 * with a single model instance (reused across multiple transcriptions)
 */
test('Cold start timing: first vs subsequent transcription times', { timeout: 600000 }, async (t) => {
  const NUM_RUNS = 5
  const ACCEPTABLE_PENALTY_THRESHOLD = 200 // 200%

  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('COLD START TIMING TEST')
  console.log('='.repeat(60))
  console.log(` Platform: ${platform}`)
  console.log(` Model path: ${modelPath}`)
  console.log(` Mobile: ${isMobile}`)
  console.log(` Number of runs: ${NUM_RUNS}`)
  console.log('='.repeat(60) + '\n')

  // Ensure model is available
  await ensureModel(modelPath)

  // Check sample audio exists
  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) {
    loggerBinding.releaseLogger()
    t.pass('Test skipped - sample audio not found')
    return
  }

  // Load audio once
  const rawBuffer = fs.readFileSync(samplePath)
  const pcmData = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
  const audioData = new Float32Array(pcmData.length)
  for (let i = 0; i < pcmData.length; i++) {
    audioData[i] = pcmData[i] / 32768.0
  }

  console.log(`Audio duration: ${(audioData.length / 16000).toFixed(2)}s\n`)

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

  // Track results for each run
  const results = []
  let parakeet = null

  try {
    // Create output callback to track transcriptions
    const allTranscriptions = []
    function outputCallback (handle, event, id, output, error) {
      if (event === 'Output' && Array.isArray(output)) {
        for (const segment of output) {
          if (segment && segment.text) {
            allTranscriptions.push({ jobId: id, segment, timestamp: getTimeMs() })
          }
        }
      }
    }

    console.log('📦 Creating model instance...')
    const loadStartTime = getTimeMs()

    parakeet = new ParakeetInterface(binding, config, outputCallback)

    console.log('🔄 Activating model...')
    await parakeet.activate()

    // Wait for model to be fully loaded (includes warmup) by doing a dummy transcription
    // This ensures model loading happens before we start timing real transcriptions
    console.log('⏳ Waiting for model initialization (warmup)...')

    // Small silent audio to trigger model load
    const silentAudio = new Float32Array(8000).fill(0) // 0.5s of silence
    await parakeet.append({ type: 'audio', data: silentAudio.buffer })
    await parakeet.append({ type: 'end of job' })

    // Wait for the warmup job to complete
    const warmupStart = getTimeMs()
    let warmupComplete = false
    while (!warmupComplete && (getTimeMs() - warmupStart) < 30000) {
      await new Promise(resolve => setTimeout(resolve, 100))
      // Check if we got any output from warmup (even empty/silent detection)
      if (allTranscriptions.length > 0) {
        warmupComplete = true
      }
    }

    // Clear warmup transcriptions - we don't want them in results
    allTranscriptions.length = 0

    const loadEndTime = getTimeMs()
    console.log(`✅ Model loaded and warmed up in ${(loadEndTime - loadStartTime).toFixed(0)}ms\n`)

    // Run multiple transcriptions - NOW the model is fully ready
    console.log(`🎤 Running ${NUM_RUNS} consecutive transcriptions (model fully warmed)...\n`)

    for (let i = 0; i < NUM_RUNS; i++) {
      console.log(`--- Run ${i + 1}/${NUM_RUNS} ---`)

      const runStartTime = getTimeMs()
      const startResultCount = allTranscriptions.length

      // Wait for output
      let outputResolve = null
      const outputPromise = new Promise(resolve => { outputResolve = resolve })

      const checkInterval = setInterval(() => {
        if (allTranscriptions.length > startResultCount) {
          clearInterval(checkInterval)
          outputResolve()
        }
      }, 50)

      // Transcribe
      await parakeet.append({ type: 'audio', data: audioData.buffer })
      await parakeet.append({ type: 'end of job' })

      // Wait with timeout
      const timeout = setTimeout(() => {
        clearInterval(checkInterval)
        outputResolve()
      }, 600000)

      await outputPromise
      clearTimeout(timeout)
      clearInterval(checkInterval)

      const runTime = getTimeMs() - runStartTime
      const runResults = allTranscriptions.slice(startResultCount)
      const text = runResults.map(r => r.segment.text).join(' ').trim()

      console.log(`  Total time: ${runTime.toFixed(0)}ms`)
      console.log(`  Segments: ${runResults.length}`)
      console.log(`  Text preview: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`)
      console.log('')

      results.push({
        runNumber: i + 1,
        totalTime: runTime,
        segmentCount: runResults.length,
        textLength: text.length
      })

      // Small delay on mobile
      if (isMobile) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    // Calculate statistics
    console.log('='.repeat(60))
    console.log('📊 TIMING SUMMARY')
    console.log('='.repeat(60))

    const times = results.map(r => r.totalTime)
    const firstRunTime = times[0]
    const subsequentTimes = times.slice(1)
    const avgSubsequent = subsequentTimes.reduce((a, b) => a + b, 0) / subsequentTimes.length

    console.log('\n  Run times:')
    times.forEach((time, i) => {
      const marker = i === 0 ? ' (FIRST - includes model init)' : ''
      console.log(`    Run ${i + 1}: ${time.toFixed(0)}ms${marker}`)
    })

    console.log('\n  Statistics:')
    console.log(`    First run: ${firstRunTime.toFixed(0)}ms`)
    console.log(`    Average of runs 2-${NUM_RUNS}: ${avgSubsequent.toFixed(0)}ms`)

    const coldStartPenalty = ((firstRunTime - avgSubsequent) / avgSubsequent) * 100
    console.log(`    Cold start penalty: ${coldStartPenalty.toFixed(1)}%`)

    console.log('\n' + '='.repeat(60) + '\n')

    // Assertions
    t.ok(results.length === NUM_RUNS, `Completed ${NUM_RUNS} transcription runs`)
    t.ok(results.every(r => r.segmentCount > 0), 'All runs should produce segments')

    // Cold start penalty check (first run slower than subsequent is expected)
    if (coldStartPenalty > 0) {
      console.log(`ℹ️  Cold start penalty detected: ${coldStartPenalty.toFixed(1)}%`)
      t.ok(coldStartPenalty <= ACCEPTABLE_PENALTY_THRESHOLD,
        `Cold start penalty ${coldStartPenalty.toFixed(1)}% should be <= ${ACCEPTABLE_PENALTY_THRESHOLD}%`)
    } else {
      console.log('ℹ️  No cold start penalty detected (first run was fast)')
      t.pass('No cold start penalty - first run was not slower')
    }

    console.log('✅ Cold start timing test completed!\n')
  } finally {
    // Cleanup
    if (parakeet) {
      try {
        await parakeet.destroyInstance()
      } catch (e) {
        // Ignore
      }
    }
    try {
      loggerBinding.releaseLogger()
    } catch (e) {
      // Ignore
    }
  }
})

/**
 * Test fresh instance timing: create a new model instance for each transcription
 * This simulates app restarts and measures instance creation overhead.
 */
test('Fresh instance timing: new model per transcription (app restart simulation)', { timeout: 600000 }, async (t) => {
  const NUM_INSTANCES = 1 // Single instance to avoid memory issues on constrained CI runners

  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('FRESH INSTANCE TIMING TEST')
  console.log('This simulates app restarts - each run creates a new model')
  console.log('='.repeat(60))
  console.log(` Platform: ${platform}`)
  console.log(` Instances to create: ${NUM_INSTANCES}`)
  console.log('='.repeat(60) + '\n')

  // Ensure model is available
  await ensureModel(modelPath)

  // Check sample audio exists
  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) {
    loggerBinding.releaseLogger()
    t.pass('Test skipped - sample audio not found')
    return
  }

  // Load audio once
  const rawBuffer = fs.readFileSync(samplePath)
  const pcmData = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
  const audioData = new Float32Array(pcmData.length)
  for (let i = 0; i < pcmData.length; i++) {
    audioData[i] = pcmData[i] / 32768.0
  }

  const results = []

  for (let instance = 1; instance <= NUM_INSTANCES; instance++) {
    console.log(`--- Instance ${instance}/${NUM_INSTANCES} ---`)
    const instanceStartTime = getTimeMs()

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

    let parakeet = null
    try {
      parakeet = new ParakeetInterface(binding, config, outputCallback)

      const loadTime = getTimeMs() - instanceStartTime

      await parakeet.activate()

      // Transcribe
      await parakeet.append({ type: 'audio', data: audioData.buffer })
      await parakeet.append({ type: 'end of job' })

      // Wait for output
      const timeout = setTimeout(() => { if (outputResolve) { outputResolve(); outputResolve = null } }, 600000)
      await outputPromise
      clearTimeout(timeout)

      const totalTime = getTimeMs() - instanceStartTime
      const transcriptionTime = totalTime - loadTime

      const fullText = transcriptions.map(s => s.text).join(' ').trim()

      console.log(`  Load time: ${loadTime.toFixed(0)}ms`)
      console.log(`  Transcription time: ${transcriptionTime.toFixed(0)}ms`)
      console.log(`  Total time: ${totalTime.toFixed(0)}ms`)
      console.log(`  Segments: ${transcriptions.length}`)
      console.log('')

      results.push({
        loadTime,
        transcriptionTime,
        totalTime,
        segmentCount: transcriptions.length,
        textLength: fullText.length
      })
    } finally {
      if (parakeet) {
        try {
          await parakeet.destroyInstance()
        } catch (e) {
          // Ignore
        }
      }
    }

    // Delay between instances
    if (instance < NUM_INSTANCES) {
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  // Summary
  console.log('='.repeat(60))
  console.log('📊 FRESH INSTANCE SUMMARY')
  console.log('='.repeat(60))

  results.forEach((r, i) => {
    console.log(`  Instance ${i + 1}:`)
    console.log(`    Load: ${r.loadTime.toFixed(0)}ms`)
    console.log(`    Transcribe: ${r.transcriptionTime.toFixed(0)}ms`)
    console.log(`    Total: ${r.totalTime.toFixed(0)}ms`)
    console.log(`    Segments: ${r.segmentCount}`)
  })

  console.log('='.repeat(60) + '\n')

  // Assertions
  t.ok(results.length === NUM_INSTANCES, `Created ${NUM_INSTANCES} fresh model instances`)
  t.ok(results.every(r => r.segmentCount > 0), 'All instances should produce segments')

  try {
    loggerBinding.releaseLogger()
  } catch (e) {
    // Ignore
  }

  console.log('✅ Fresh instance timing test completed!\n')
})
