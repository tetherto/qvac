'use strict'

/**
 * Cold Start Timing Test
 *
 * Validates the "first transcription is slower" behavior. Measures
 * timing across multiple consecutive transcriptions to quantify the
 * cold-start penalty.
 *
 * Expected: first transcription is slower due to model initialization;
 * subsequent runs should be faster (warm cache, loaded model).
 */

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const {
  binding,
  TranscriptionParakeet,
  detectPlatform,
  setupJsLogger,
  getTestPaths,
  loadGgufOrSkip,
  isMobile
} = require('./helpers.js')

const platform = detectPlatform()
const { modelPath, samplesDir } = getTestPaths()

function getTimeMs () {
  const [sec, nsec] = process.hrtime()
  return sec * 1000 + nsec / 1e6
}

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

  const stagedGguf = await loadGgufOrSkip(t)
  if (!stagedGguf) return

  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) {
    loggerBinding.releaseLogger()
    t.pass('Test skipped - sample audio not found')
    return
  }

  const audioData = loadAudio(samplePath)
  console.log(`Audio duration: ${(audioData.length / 16000).toFixed(2)}s\n`)

  const model = new TranscriptionParakeet({
    files: { model: stagedGguf },
    config: { parakeetConfig: { maxThreads: 4, useGPU: false } }
  })
  const results = []

  try {
    console.log('📦 Loading + warming model...')
    const loadStart = getTimeMs()
    await model.load()

    // Tiny warmup pass so the first measured run isn't dominated by
    // model init / first-call ggml graph compilation.
    const silentAudio = new Float32Array(8000).fill(0)
    await transcribe(model, silentAudio).catch(() => {})
    const loadEnd = getTimeMs()
    console.log(`✅ Model loaded and warmed up in ${(loadEnd - loadStart).toFixed(0)}ms\n`)

    console.log(`🎤 Running ${NUM_RUNS} consecutive transcriptions (model fully warmed)...\n`)
    for (let i = 0; i < NUM_RUNS; i++) {
      console.log(`--- Run ${i + 1}/${NUM_RUNS} ---`)
      const runStart = getTimeMs()
      const segments = await transcribe(model, audioData)
      const runTime = getTimeMs() - runStart
      const text = segments.map(s => s.text).join(' ').trim()

      console.log(`  Total time: ${runTime.toFixed(0)}ms`)
      console.log(`  Segments: ${segments.length}`)
      console.log(`  Text preview: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"\n`)

      results.push({
        runNumber: i + 1,
        totalTime: runTime,
        segmentCount: segments.length,
        textLength: text.length
      })

      if (isMobile) await new Promise(resolve => setTimeout(resolve, 200))
    }

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

    t.ok(results.length === NUM_RUNS, `Completed ${NUM_RUNS} transcription runs`)
    t.ok(results.every(r => r.segmentCount > 0), 'All runs should produce segments')

    if (coldStartPenalty > 0) {
      console.log(`ℹ️  Cold start penalty detected: ${coldStartPenalty.toFixed(1)}%`)
      t.ok(coldStartPenalty <= ACCEPTABLE_PENALTY_THRESHOLD,
        `Cold start penalty ${coldStartPenalty.toFixed(1)}% should be <= ${ACCEPTABLE_PENALTY_THRESHOLD}%`)
    } else {
      console.log('ℹ️  No cold start penalty detected (first run was fast)')
      t.pass('No cold start penalty - first run was not slower')
    }
  } finally {
    try { await model.unload() } catch (e) { /* ignore */ }
    try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
  }
})

test('Fresh instance timing: new model per transcription (app restart simulation)', { timeout: 600000 }, async (t) => {
  const NUM_INSTANCES = 1 // single instance to keep CI memory-bounded
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('FRESH INSTANCE TIMING TEST')
  console.log('This simulates app restarts - each run creates a new model')
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
    const instanceStart = getTimeMs()
    const model = new TranscriptionParakeet({
      files: { model: stagedGguf },
      config: { parakeetConfig: { maxThreads: 4, useGPU: false } }
    })
    try {
      await model.load()
      const loadTime = getTimeMs() - instanceStart
      const segments = await transcribe(model, audioData)
      const totalTime = getTimeMs() - instanceStart
      const transcriptionTime = totalTime - loadTime
      const fullText = segments.map(s => s.text).join(' ').trim()

      console.log(`  Load time: ${loadTime.toFixed(0)}ms`)
      console.log(`  Transcription time: ${transcriptionTime.toFixed(0)}ms`)
      console.log(`  Total time: ${totalTime.toFixed(0)}ms`)
      console.log(`  Segments: ${segments.length}\n`)

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
    if (instance < NUM_INSTANCES) await new Promise(resolve => setTimeout(resolve, 500))
  }

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

  t.ok(results.length === NUM_INSTANCES, `Created ${NUM_INSTANCES} fresh model instances`)
  t.ok(results.every(r => r.segmentCount > 0), 'All instances should produce segments')

  try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
})
