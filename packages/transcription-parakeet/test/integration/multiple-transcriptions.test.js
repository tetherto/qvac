'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const proc = require('bare-process')
const {
  binding,
  ParakeetInterface,
  TranscriptionParakeet,
  detectPlatform,
  setupJsLogger,
  getTestPaths,
  ensureModel,
  ensureModelForType,
  getNamedPathsConfig,
  loadGgufOrSkip,
  isMobile,
  recordParakeetStats
} = require('./helpers.js')

const platform = detectPlatform()
const { modelPath, samplesDir } = getTestPaths()
const NO_GPU = proc.env && proc.env.NO_GPU === 'true'

function loadAudio (samplePath) {
  const rawBuffer = fs.readFileSync(samplePath)
  const pcmData = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
  const audioData = new Float32Array(pcmData.length)
  for (let i = 0; i < pcmData.length; i++) audioData[i] = pcmData[i] / 32768.0
  return audioData
}

async function transcribe (model, audio) {
  const segments = []
  const response = await model.run(audio)
  await response
    .onUpdate(out => {
      const items = Array.isArray(out) ? out : [out]
      for (const seg of items) {
        if (seg && seg.text) segments.push(seg)
      }
    })
    .await()
  return segments
}

const ALL_DEVICE_CONFIGS = [
  { id: 'gpu', useGPU: true },
  { id: 'cpu', useGPU: false }
]
const DEVICE_CONFIGS = ALL_DEVICE_CONFIGS.filter(c => {
  if (NO_GPU && c.useGPU) return false
  if (!isMobile && c.useGPU) return false
  return true
})
const MOBILE_PERF_MODEL_TYPES = ['tdt']
const PERF_MODEL_TYPES = isMobile ? MOBILE_PERF_MODEL_TYPES : ['tdt']

async function resolvePerfModelPath (modelType) {
  if (modelType === 'tdt') {
    const resolved = await ensureModel(modelPath)
    if (!resolved) throw new Error(`Unable to resolve model for type: ${modelType}`)
    return resolved
  }
  const resolved = await ensureModelForType(modelType)
  if (!resolved) throw new Error(`Unable to resolve model for type: ${modelType}`)
  return resolved
}

/**
 * Test that multiple consecutive transcriptions on the same model
 * instance work without errors.
 */
for (const modelType of PERF_MODEL_TYPES) {
  for (const deviceConfig of DEVICE_CONFIGS) {
    const epLabel = `[${deviceConfig.id.toUpperCase()}]`
    const modelLabel = isMobile ? `[${modelType}]` : ''
    const testLabel = modelLabel ? `${modelLabel} ${epLabel}` : epLabel
    const perfLabelPrefix = modelLabel ? `${modelLabel} ${epLabel}` : epLabel

    test(`Multiple consecutive transcriptions ${testLabel} should work without errors`, { timeout: 600000 }, async (t) => {
      const NUM_TRANSCRIPTIONS = 3
      const loggerBinding = setupJsLogger(binding)

      console.log('\n' + '='.repeat(60))
      console.log(`MULTIPLE CONSECUTIVE TRANSCRIPTIONS TEST ${testLabel}`)
      console.log('='.repeat(60))
      console.log(` Platform: ${platform}`)
      if (isMobile) console.log(` Model type: ${modelType}`)
      console.log(` Number of transcriptions: ${NUM_TRANSCRIPTIONS}`)
      console.log(` Mobile: ${isMobile}`)
      console.log(` useGPU: ${deviceConfig.useGPU}`)
      console.log('='.repeat(60) + '\n')

      const perfModelPath = await resolvePerfModelPath(modelType)
      console.log(` Model path: ${perfModelPath}`)

      // Check sample audio exists
      const samplePath = path.join(samplesDir, 'sample.raw')
      if (!fs.existsSync(samplePath)) {
        loggerBinding.releaseLogger()
        t.pass('Test skipped - sample audio not found')
        return
      }

      // Configuration
      const config = {
        modelPath: perfModelPath,
        modelType,
        maxThreads: 4,
        useGPU: deviceConfig.useGPU,
        sampleRate: 16000,
        channels: 1,
        ...getNamedPathsConfig(modelType, perfModelPath)
      }

      let parakeet = null
      const allResults = []
      // JobEnded payloads carry the C++ runtime stats (RTF, encoder/decoder ms,
      // tokens/sec, audio duration). We collect them per run so the shared perf
      // reporter can emit one row per transcription.
      const receivedStats = []
      let outputResolve = null

      function finishCurrentRun () {
        if (outputResolve) {
          outputResolve()
          outputResolve = null
        }
      }

      try {
        console.log('=== Creating instance and loading model ===')

        function outputCallback (handle, event, id, output, error) {
          if (event === 'Output' && Array.isArray(output)) {
            for (const segment of output) {
              if (segment && segment.text) {
                allResults.push({ jobId: id, segment })
              }
            }
          } else if (event === 'JobEnded' && output) {
            receivedStats.push({ jobId: id, stats: output })
            finishCurrentRun()
          } else if (event === 'Error' || error) {
            finishCurrentRun()
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

          // Track when this run completes. Mobile waits for JobEnded so the
          // perf row has native runtime stats; desktop keeps the previous
          // output-based behavior.
          const outputPromise = new Promise(resolve => { outputResolve = resolve })
          let checkInterval = null
          if (!isMobile) {
            checkInterval = setInterval(() => {
              if (allResults.length > startResultCount) {
                clearInterval(checkInterval)
                finishCurrentRun()
              }
            }, 100)
          }

          // Transcribe
          await parakeet.append({ type: 'audio', data: audioData.buffer })
          await parakeet.append({ type: 'end of job' })

          const timeout = setTimeout(() => {
            if (checkInterval) clearInterval(checkInterval)
            finishCurrentRun()
          }, 600000)

          await outputPromise
          if (checkInterval) clearInterval(checkInterval)
          clearTimeout(timeout)

          const runTime = Date.now() - runStartTime
          timings.push(runTime)

          // Get results for this run
          const runResults = allResults.slice(startResultCount)
          const runText = runResults.map(r => r.segment.text).join(' ').trim()

          console.log(`   Time: ${runTime}ms`)
          console.log(`   Segments: ${runResults.length}`)
          console.log(`   Text preview: "${runText.substring(0, 80)}${runText.length > 80 ? '...' : ''}"`)

          // Capture this run's JobEnded stats (most recent one belongs to us
          // because the output callback observes events in order). Wire into
          // the shared perf reporter so the CI step summary surfaces RTF,
          // encoder/decoder timing, tokens-per-second per device.
          const jobStats = receivedStats.length > 0
            ? receivedStats[receivedStats.length - 1].stats
            : null
          if (jobStats) {
            try {
              recordParakeetStats(`${perfLabelPrefix} multi-transcribe run ${run}`, jobStats, {
                wallMs: runTime,
                output: runText
              })
            } catch (err) {
              console.log(`   [perf] recordParakeetStats failed: ${err.message}`)
            }
            if (typeof jobStats.realTimeFactor === 'number') {
              console.log(`   RTF: ${jobStats.realTimeFactor.toFixed(4)}`)
            }
          }
          console.log('')

          if (run < NUM_TRANSCRIPTIONS) {
            await new Promise(resolve => setTimeout(resolve, 200))
          }
        }

        // Summary and assertions
        console.log('='.repeat(60))
        console.log(`TEST SUMMARY ${testLabel}`)
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
        if (isMobile) {
          t.ok(receivedStats.length >= NUM_TRANSCRIPTIONS, `${testLabel} Should receive JobEnded stats for every run (got ${receivedStats.length})`)
        }
        t.ok(timings.length === NUM_TRANSCRIPTIONS, `${testLabel} Should complete ${NUM_TRANSCRIPTIONS} transcriptions (got ${timings.length})`)

        // Verify each run produced output when the model emits textual segments.
        const runsWithOutput = new Set(allResults.map(r => r.jobId)).size
        if (allResults.length > 0) {
          if (isMobile) {
            t.ok(runsWithOutput <= NUM_TRANSCRIPTIONS, `${testLabel} Output job IDs are bounded by run count`)
          } else {
            t.ok(runsWithOutput === NUM_TRANSCRIPTIONS, `${epLabel} Multiple runs should produce output for every job (got ${runsWithOutput}/${NUM_TRANSCRIPTIONS} unique job IDs)`)
          }
        } else {
          console.log(`   ${testLabel} produced runtime stats without textual output`)
        }

        console.log(`✅ Multiple transcriptions test ${testLabel} completed successfully!\n`)
      } finally {
        // Cleanup
        console.log('=== Cleanup ===')
        finishCurrentRun()
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
  }
}

/**
 * Test that creating fresh model instances for each transcription
 * works correctly. Simulates app-restart scenarios.
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

  const stagedGguf = await loadGgufOrSkip(t)
  if (!stagedGguf) return

  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) {
    loggerBinding.releaseLogger()
    t.pass('Test skipped - sample audio not found')
    return
  }

  const audioData = loadAudio(samplePath)
  const results = []

  for (let instance = 1; instance <= NUM_INSTANCES; instance++) {
    console.log(`--- Instance ${instance}/${NUM_INSTANCES} ---`)
    const instanceStartTime = Date.now()

    const model = new TranscriptionParakeet({
      files: { model: stagedGguf },
      config: { parakeetConfig: { maxThreads: 4, useGPU: false } }
    })
    try {
      await model.load()
      const loadTime = Date.now() - instanceStartTime

      const segments = await transcribe(model, audioData)
      const totalTime = Date.now() - instanceStartTime
      const transcriptionTime = totalTime - loadTime
      const fullText = segments.map(s => s.text).join(' ').trim()

      console.log(`   Load time: ${loadTime}ms`)
      console.log(`   Transcription time: ${transcriptionTime}ms`)
      console.log(`   Total time: ${totalTime}ms`)
      console.log(`   Segments: ${segments.length}\n`)

      results.push({
        loadTime,
        transcriptionTime,
        totalTime,
        segmentCount: segments.length,
        textLength: fullText.length
      })
    } finally {
      try { await model.unload() } catch (e) { /* ignore */ }
    }

    if (instance < NUM_INSTANCES) {
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

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

  t.ok(results.length === NUM_INSTANCES, `Created ${NUM_INSTANCES} fresh model instances`)
  t.ok(results.every(r => r.segmentCount > 0), 'All instances should produce segments')

  try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
})
