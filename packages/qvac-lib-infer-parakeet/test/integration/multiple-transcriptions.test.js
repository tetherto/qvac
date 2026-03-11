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
  ensureModel,
  getNamedPathsConfig,
  isMobile
} = require('./helpers.js')

const platform = detectPlatform()
const { modelPath, samplesDir } = getTestPaths()

/**
 * Test that multiple consecutive transcriptions work without errors.
 * This verifies:
 * - Model can be reused across multiple transcriptions
 * - No memory leaks or state corruption between runs
 * - Job IDs increment correctly
 */
test('Multiple consecutive transcriptions should work without errors', { timeout: 600000 }, async (t) => {
  const NUM_TRANSCRIPTIONS = 3
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('MULTIPLE CONSECUTIVE TRANSCRIPTIONS TEST')
  console.log('='.repeat(60))
  console.log(` Platform: ${platform}`)
  console.log(` Model path: ${modelPath}`)
  console.log(` Number of transcriptions: ${NUM_TRANSCRIPTIONS}`)
  console.log(` Mobile: ${isMobile}`)
  console.log('='.repeat(60) + '\n')

  // Ensure model is downloaded
  await ensureModel(modelPath)

  // Check sample audio exists
  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) {
    loggerBinding.releaseLogger()
    t.pass('Test skipped - sample audio not found')
    return
  }

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

  let parakeet = null
  const allResults = []

  try {
    console.log('=== Creating instance and loading model ===')

    // Output callback to track all transcriptions
    function outputCallback (handle, event, id, output, error) {
      if (event === 'Output' && Array.isArray(output)) {
        for (const segment of output) {
          if (segment && segment.text) {
            allResults.push({ jobId: id, segment })
          }
        }
      }
    }

    parakeet = new ParakeetInterface(binding, config, outputCallback)

    await parakeet.activate()
    console.log('   Model activated\n')

    // Load audio once (read into memory)
    const rawBuffer = fs.readFileSync(samplePath)
    const pcmData = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
    const audioData = new Float32Array(pcmData.length)
    for (let i = 0; i < pcmData.length; i++) {
      audioData[i] = pcmData[i] / 32768.0
    }
    console.log(`   Audio duration: ${(audioData.length / 16000).toFixed(2)}s\n`)

    // Run multiple transcriptions
    const timings = []

    for (let run = 1; run <= NUM_TRANSCRIPTIONS; run++) {
      console.log(`=== Transcription ${run}/${NUM_TRANSCRIPTIONS} ===`)
      const runStartTime = Date.now()

      // Clear results for this run
      const startResultCount = allResults.length

      // Track when this run completes
      let outputResolve = null
      const outputPromise = new Promise(resolve => { outputResolve = resolve })

      // Watch for output from this run
      const checkInterval = setInterval(() => {
        if (allResults.length > startResultCount) {
          clearInterval(checkInterval)
          outputResolve()
        }
      }, 100)

      // Transcribe
      await parakeet.append({ type: 'audio', data: audioData.buffer })
      await parakeet.append({ type: 'end of job' })

      // Wait for output with timeout
      const timeout = setTimeout(() => {
        clearInterval(checkInterval)
        outputResolve()
      }, 600000)

      await outputPromise
      clearTimeout(timeout)

      const runTime = Date.now() - runStartTime
      timings.push(runTime)

      // Get results for this run
      const runResults = allResults.slice(startResultCount)
      const runText = runResults.map(r => r.segment.text).join(' ').trim()

      console.log(`   Time: ${runTime}ms`)
      console.log(`   Segments: ${runResults.length}`)
      console.log(`   Text preview: "${runText.substring(0, 80)}${runText.length > 80 ? '...' : ''}"`)
      console.log('')

      // Small delay between runs (helps with memory cleanup)
      if (run < NUM_TRANSCRIPTIONS) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    // Summary and assertions
    console.log('='.repeat(60))
    console.log('TEST SUMMARY')
    console.log('='.repeat(60))

    console.log('\n  Timing per run:')
    timings.forEach((time, i) => {
      console.log(`    Run ${i + 1}: ${time}ms`)
    })

    const avgTime = timings.reduce((a, b) => a + b, 0) / timings.length
    console.log(`\n  Average time: ${avgTime.toFixed(0)}ms`)
    console.log(`  Total segments: ${allResults.length}`)
    console.log('='.repeat(60) + '\n')

    // Assertions
    t.ok(allResults.length > 0, `Should produce segments across all runs (got ${allResults.length})`)
    t.ok(timings.length === NUM_TRANSCRIPTIONS, `Should complete ${NUM_TRANSCRIPTIONS} transcriptions (got ${timings.length})`)

    // Verify each run produced output
    const runsWithOutput = new Set(allResults.map(r => r.jobId)).size
    t.ok(runsWithOutput === NUM_TRANSCRIPTIONS, `Multiple runs should produce output for every job (got ${runsWithOutput}/${NUM_TRANSCRIPTIONS} unique job IDs)`)

    console.log('✅ Multiple transcriptions test completed successfully!\n')
  } finally {
    // Cleanup
    console.log('=== Cleanup ===')
    if (parakeet) {
      try {
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

/**
 * Test that creating fresh model instances for each transcription works correctly.
 * This simulates app restart scenarios.
 */
test('Fresh model instance per transcription (app restart simulation)', { timeout: 600000 }, async (t) => {
  const NUM_INSTANCES = 2
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('FRESH INSTANCE PER TRANSCRIPTION TEST')
  console.log('='.repeat(60))
  console.log(` Platform: ${platform}`)
  console.log(` Instances to create: ${NUM_INSTANCES}`)
  console.log('='.repeat(60) + '\n')

  // Ensure model is downloaded
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
    const instanceStartTime = Date.now()

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

      const loadTime = Date.now() - instanceStartTime

      await parakeet.activate()

      // Transcribe
      await parakeet.append({ type: 'audio', data: audioData.buffer })
      await parakeet.append({ type: 'end of job' })

      // Wait for output
      const timeout = setTimeout(() => { if (outputResolve) { outputResolve(); outputResolve = null } }, 600000)
      await outputPromise
      clearTimeout(timeout)

      const totalTime = Date.now() - instanceStartTime
      const transcriptionTime = totalTime - loadTime

      const fullText = transcriptions.map(s => s.text).join(' ').trim()

      console.log(`   Load time: ${loadTime}ms`)
      console.log(`   Transcription time: ${transcriptionTime}ms`)
      console.log(`   Total time: ${totalTime}ms`)
      console.log(`   Segments: ${transcriptions.length}`)
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
          // Ignore cleanup errors
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
  console.log('FRESH INSTANCE SUMMARY')
  console.log('='.repeat(60))

  results.forEach((r, i) => {
    console.log(`  Instance ${i + 1}:`)
    console.log(`    Load: ${r.loadTime}ms`)
    console.log(`    Transcribe: ${r.transcriptionTime}ms`)
    console.log(`    Total: ${r.totalTime}ms`)
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

  console.log('✅ Fresh instance test completed successfully!\n')
})
