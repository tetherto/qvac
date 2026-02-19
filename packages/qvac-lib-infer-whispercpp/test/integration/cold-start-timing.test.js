'use strict'

/**
 * Cold Start Timing Test
 *
 * This test validates the "first transcription is slower" issue.
 * It measures timing across multiple consecutive transcriptions
 * to quantify the cold start penalty.
 *
 * Expected behavior:
 * - With proper warmup, first run should NOT be significantly slower
 * - Current behavior (reported): ~50% slower on first run
 */

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')
const TranscriptionWhispercpp = require('../../index.js')
const FakeDL = require('../mocks/loader.fake.js')
const { ensureWhisperModel, ensureVADModel, getAssetPath, isMobile } = require('./helpers.js')

function createLoader () {
  return new FakeDL({})
}

async function getModelPaths () {
  // Use writable directory for models
  const modelsDir = isMobile ? path.join(global.testDir || os.tmpdir(), 'models') : path.resolve(__dirname, '../../examples/models')

  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true })
  }

  const modelPath = path.join(modelsDir, 'ggml-tiny.bin')
  const vadModelPath = path.join(modelsDir, 'ggml-silero-v5.1.2.bin')

  // Ensure models are downloaded
  await ensureWhisperModel(modelPath)
  await ensureVADModel(vadModelPath)

  // Get audio path using getAssetPath for mobile compatibility
  let audioPath
  try {
    audioPath = getAssetPath('sample.raw')
  } catch (e) {
    // Fallback for desktop
    audioPath = path.resolve(__dirname, '../../examples/samples/sample.raw')
  }

  return {
    modelPath,
    vadModelPath: fs.existsSync(vadModelPath) ? vadModelPath : null,
    audioPath,
    modelsDir
  }
}

/**
 * High-resolution timer using hrtime (works in Bare)
 */
function getTimeMs () {
  const [sec, nsec] = process.hrtime()
  return sec * 1000 + nsec / 1e6
}

/**
 * Run a single transcription and return timing info
 */
async function runTimedTranscription (model, audioPath) {
  const startTime = getTimeMs()
  let firstSegmentTime = null

  const audioStream = fs.createReadStream(audioPath)
  const response = await model.run(audioStream)

  const segments = []
  await response
    .onUpdate((outputArr) => {
      if (firstSegmentTime === null) {
        firstSegmentTime = getTimeMs()
      }
      const items = Array.isArray(outputArr) ? outputArr : [outputArr]
      segments.push(...items)
    })
    .await()

  const endTime = getTimeMs()

  return {
    totalTime: endTime - startTime,
    timeToFirstSegment: firstSegmentTime ? firstSegmentTime - startTime : null,
    segmentCount: segments.length,
    text: segments.map(s => s?.text || '').join(' ').trim()
  }
}

// Works on both mobile and desktop - fewer runs on mobile
test('Cold start timing: measure first vs subsequent transcription times', { timeout: 300000 }, async (t) => {
  const paths = await getModelPaths()

  const NUM_RUNS = 5
  const ACCEPTABLE_PENALTY_THRESHOLD = 100 // 100% = 2x slower is acceptable

  console.log('\n' + '='.repeat(60))
  console.log('COLD START TIMING TEST')
  console.log('='.repeat(60))
  console.log(`Model: ${path.basename(paths.modelPath)}`)
  console.log(`VAD Model: ${paths.vadModelPath ? path.basename(paths.vadModelPath) : 'none'}`)
  console.log(`Audio: ${path.basename(paths.audioPath)}`)
  console.log(`Platform: ${isMobile ? 'mobile' : 'desktop'}`)
  console.log(`Runs: ${NUM_RUNS}`)
  console.log('='.repeat(60) + '\n')

  // Verify files exist
  if (!fs.existsSync(paths.modelPath)) {
    console.log(`⚠️ Model not found: ${paths.modelPath}`)
    t.pass('Test skipped - model not found')
    return
  }
  if (!fs.existsSync(paths.audioPath)) {
    console.log(`⚠️ Audio not found: ${paths.audioPath}`)
    t.pass('Test skipped - audio not found')
    return
  }

  const loader = createLoader()
  const modelName = path.basename(paths.modelPath)

  const config = {
    path: paths.modelPath,
    vadModelPath: paths.vadModelPath,
    whisperConfig: {
      language: 'en',
      audio_format: 's16le',
      temperature: 0.0,
      suppress_nst: true
    }
  }

  if (paths.vadModelPath && fs.existsSync(paths.vadModelPath)) {
    config.whisperConfig.vad_model_path = paths.vadModelPath
    config.whisperConfig.vad_params = {
      threshold: 0.5,
      min_speech_duration_ms: 100,
      min_silence_duration_ms: 100
    }
  }

  let model
  try {
    // Create model instance
    console.log('📦 Creating model instance...')
    const loadStartTime = getTimeMs()

    model = new TranscriptionWhispercpp({
      modelName,
      loader,
      diskPath: paths.modelsDir
    }, config)

    // Load model (this should trigger warmup)
    console.log('🔄 Loading model (with warmup)...')
    await model._load()

    const loadEndTime = getTimeMs()
    console.log(`✅ Model loaded in ${(loadEndTime - loadStartTime).toFixed(0)}ms\n`)

    // Run multiple transcriptions
    const results = []

    console.log(`🎤 Running ${NUM_RUNS} consecutive transcriptions...\n`)

    for (let i = 0; i < NUM_RUNS; i++) {
      console.log(`--- Run ${i + 1}/${NUM_RUNS} ---`)

      const result = await runTimedTranscription(model, paths.audioPath)
      results.push(result)

      console.log(`  Total time: ${result.totalTime.toFixed(0)}ms`)
      if (result.timeToFirstSegment) {
        console.log(`  Time to first segment: ${result.timeToFirstSegment.toFixed(0)}ms`)
      }
      console.log(`  Segments: ${result.segmentCount}`)
      console.log(`  Text preview: "${result.text.substring(0, 50)}${result.text.length > 50 ? '...' : ''}"\n`)

      // Small delay on mobile to allow memory cleanup
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
      const marker = i === 0 ? ' (FIRST)' : ''
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
    t.ok(coldStartPenalty <= ACCEPTABLE_PENALTY_THRESHOLD, `Cold start penalty ${coldStartPenalty.toFixed(1)}% should be <= ${ACCEPTABLE_PENALTY_THRESHOLD}%`)
  } finally {
    // Cleanup
    if (model) {
      try {
        await model.unload()
      } catch (e) {
        // ignore
      }
    }
  }
})

// Fresh instance test - fewer runs on mobile
test('Cold start: fresh model instance per transcription', { timeout: 300000 }, async (t) => {
  const paths = await getModelPaths()

  const NUM_RUNS = 3

  console.log('\n' + '='.repeat(60))
  console.log('FRESH INSTANCE TIMING TEST')
  console.log('This simulates app restarts - each run creates a new model')
  console.log(`Platform: ${isMobile ? 'mobile' : 'desktop'}, Runs: ${NUM_RUNS}`)
  console.log('='.repeat(60) + '\n')

  if (!fs.existsSync(paths.modelPath) || !fs.existsSync(paths.audioPath)) {
    t.pass('Test skipped - files not found')
    return
  }

  const results = []

  for (let i = 0; i < NUM_RUNS; i++) {
    console.log(`--- Instance ${i + 1}/${NUM_RUNS} ---`)

    const loader = createLoader()
    const modelName = path.basename(paths.modelPath)

    const config = {
      path: paths.modelPath,
      vadModelPath: paths.vadModelPath,
      whisperConfig: {
        language: 'en',
        audio_format: 's16le'
      }
    }

    if (paths.vadModelPath && fs.existsSync(paths.vadModelPath)) {
      config.whisperConfig.vad_model_path = paths.vadModelPath
    }

    let model
    try {
      // Time includes model creation and loading
      const instanceStartTime = getTimeMs()

      model = new TranscriptionWhispercpp({
        modelName,
        loader,
        diskPath: paths.modelsDir
      }, config)

      await model._load()

      const loadTime = getTimeMs() - instanceStartTime

      // Run single transcription
      const result = await runTimedTranscription(model, paths.audioPath)

      const totalTime = getTimeMs() - instanceStartTime

      console.log(`  Load time: ${loadTime.toFixed(0)}ms`)
      console.log(`  Transcription time: ${result.totalTime.toFixed(0)}ms`)
      console.log(`  Total (load + transcribe): ${totalTime.toFixed(0)}ms\n`)

      results.push({
        loadTime,
        transcriptionTime: result.totalTime,
        totalTime,
        ...result
      })
    } finally {
      if (model) {
        try {
          await model.unload()
        } catch (e) {
          // ignore
        }
      }
    }

    // Delay between instances on mobile
    if (isMobile) {
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  console.log('='.repeat(60))
  console.log('📊 FRESH INSTANCE SUMMARY')
  console.log('='.repeat(60))

  results.forEach((r, i) => {
    console.log(`  Instance ${i + 1}:`)
    console.log(`    Load: ${r.loadTime.toFixed(0)}ms`)
    console.log(`    Transcribe: ${r.transcriptionTime.toFixed(0)}ms`)
    console.log(`    Total: ${r.totalTime.toFixed(0)}ms`)
  })

  console.log('='.repeat(60) + '\n')

  t.ok(results.length === NUM_RUNS, `Created ${NUM_RUNS} fresh model instances`)
})
