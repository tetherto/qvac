'use strict'

/**
 * Real-Time Factor (RTF) Benchmark
 *
 * Captures RTF and related inference performance metrics directly from
 * the C++ addon's runtimeStats (emitted on the JobEnded event).
 *
 * RTF = processing_time / audio_duration
 *   < 1.0  → faster than real-time
 *   = 1.0  → exactly real-time
 *   > 1.0  → slower than real-time
 *
 * The test runs multiple transcriptions after a warmup pass and
 * reports per-run and aggregate statistics (mean, min, max, stddev,
 * p50, p95).  Results are also written to a JSON file so CI can
 * upload them as artifacts for cross-device comparison.
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
} = require('../integration/helpers.js')

const platform = detectPlatform()
const { modelPath, samplesDir } = getTestPaths()

const SAMPLE_RATE = 16000
const NUM_WARMUP = 1
const NUM_BENCHMARK_RUNS = isMobile ? 3 : 5
const RTF_RESULTS_DIR = path.resolve(__dirname, '../../benchmarks/results')

function getTimeMs () {
  const [sec, nsec] = process.hrtime()
  return sec * 1000 + nsec / 1e6
}

function percentile (sorted, p) {
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function stats (values) {
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)
  const mean = sum / sorted.length
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / sorted.length
  return {
    mean,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    stddev: Math.sqrt(variance),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    count: sorted.length
  }
}

test('RTF benchmark: collect real-time factor on CI device', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(70))
  console.log('RTF BENCHMARK')
  console.log('='.repeat(70))
  console.log(`  Platform:       ${platform}`)
  console.log(`  Model path:     ${modelPath}`)
  console.log(`  Mobile:         ${isMobile}`)
  console.log(`  Warmup runs:    ${NUM_WARMUP}`)
  console.log(`  Benchmark runs: ${NUM_BENCHMARK_RUNS}`)
  console.log('='.repeat(70) + '\n')

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

  const audioDurationSec = audioData.length / SAMPLE_RATE
  console.log(`  Audio samples:  ${audioData.length}`)
  console.log(`  Audio duration: ${audioDurationSec.toFixed(2)}s\n`)

  const config = {
    modelPath,
    modelType: 'tdt',
    maxThreads: 4,
    useGPU: false,
    sampleRate: SAMPLE_RATE,
    channels: 1,
    ...getNamedPathsConfig('tdt', modelPath)
  }

  const allResults = []
  const receivedStats = []
  let parakeet = null

  try {
    function outputCallback (handle, event, id, output, error) {
      if (event === 'JobEnded' && output) {
        receivedStats.push(output)
      }
    }

    console.log('Loading model...')
    const loadStart = getTimeMs()
    parakeet = new ParakeetInterface(binding, config, outputCallback)
    await parakeet.activate()

    // Warmup with silent audio to trigger full model initialisation
    const silentAudio = new Float32Array(SAMPLE_RATE).fill(0)
    receivedStats.length = 0
    await parakeet.append({ type: 'audio', data: silentAudio.buffer })
    await parakeet.append({ type: 'end of job' })

    const warmupDeadline = getTimeMs() + 30000
    while (receivedStats.length === 0 && getTimeMs() < warmupDeadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    const loadMs = getTimeMs() - loadStart
    console.log(`Model loaded and initialised in ${loadMs.toFixed(0)}ms\n`)

    // --- Warmup runs (discard) ---
    for (let w = 0; w < NUM_WARMUP; w++) {
      console.log(`[warmup ${w + 1}/${NUM_WARMUP}]`)
      receivedStats.length = 0
      await parakeet.append({ type: 'audio', data: audioData.buffer })
      await parakeet.append({ type: 'end of job' })

      const deadline = getTimeMs() + 600000
      while (receivedStats.length === 0 && getTimeMs() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }

      if (receivedStats.length > 0) {
        const s = receivedStats[receivedStats.length - 1]
        console.log(`  RTF (warmup): ${(s.realTimeFactor || 0).toFixed(4)}`)
      }
    }

    console.log(`\nRunning ${NUM_BENCHMARK_RUNS} benchmark iterations...\n`)

    // --- Benchmark runs ---
    for (let i = 0; i < NUM_BENCHMARK_RUNS; i++) {
      receivedStats.length = 0
      const runStart = getTimeMs()

      await parakeet.append({ type: 'audio', data: audioData.buffer })
      await parakeet.append({ type: 'end of job' })

      const deadline = getTimeMs() + 600000
      while (receivedStats.length === 0 && getTimeMs() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }

      const wallMs = getTimeMs() - runStart

      if (receivedStats.length === 0) {
        console.log(`  Run ${i + 1}: TIMEOUT (no JobEnded received)`)
        continue
      }

      const jobStats = receivedStats[receivedStats.length - 1]
      const run = {
        iteration: i + 1,
        wallMs,
        rtf: jobStats.realTimeFactor || 0,
        totalTimeSec: jobStats.totalTime || 0,
        audioDurationMs: jobStats.audioDurationMs || 0,
        tokensPerSecond: jobStats.tokensPerSecond || 0,
        msPerToken: jobStats.msPerToken || 0,
        totalTokens: jobStats.totalTokens || 0,
        totalSamples: jobStats.totalSamples || 0,
        modelLoadMs: jobStats.modelLoadMs || 0,
        melSpecMs: jobStats.melSpecMs || 0,
        encoderMs: jobStats.encoderMs || 0,
        decoderMs: jobStats.decoderMs || 0,
        totalWallMs: jobStats.totalWallMs || 0
      }

      allResults.push(run)

      console.log(`  Run ${i + 1}/${NUM_BENCHMARK_RUNS}: ` +
        `RTF=${run.rtf.toFixed(4)}  ` +
        `wall=${wallMs.toFixed(0)}ms  ` +
        `tokens/s=${run.tokensPerSecond.toFixed(1)}  ` +
        `encoder=${run.encoderMs.toFixed(0)}ms  ` +
        `decoder=${run.decoderMs.toFixed(0)}ms`)

      if (isMobile) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    // --- Aggregate statistics ---
    if (allResults.length === 0) {
      t.fail('No benchmark results collected')
      return
    }

    const rtfValues = allResults.map(r => r.rtf)
    const wallValues = allResults.map(r => r.wallMs)
    const tpsValues = allResults.map(r => r.tokensPerSecond)
    const encoderValues = allResults.map(r => r.encoderMs)
    const decoderValues = allResults.map(r => r.decoderMs)

    const rtfStats = stats(rtfValues)
    const wallStats = stats(wallValues)
    const tpsStats = stats(tpsValues)
    const encoderStats = stats(encoderValues)
    const decoderStats = stats(decoderValues)

    console.log('\n' + '='.repeat(70))
    console.log('RTF BENCHMARK RESULTS')
    console.log('='.repeat(70))
    console.log(`\n  Platform:        ${platform}`)
    console.log(`  Audio duration:  ${audioDurationSec.toFixed(2)}s`)
    console.log(`  Iterations:      ${allResults.length}`)
    console.log('')
    console.log('  Real-Time Factor (RTF):')
    console.log(`    Mean:   ${rtfStats.mean.toFixed(4)}`)
    console.log(`    Min:    ${rtfStats.min.toFixed(4)}`)
    console.log(`    Max:    ${rtfStats.max.toFixed(4)}`)
    console.log(`    Stddev: ${rtfStats.stddev.toFixed(4)}`)
    console.log(`    P50:    ${rtfStats.p50.toFixed(4)}`)
    console.log(`    P95:    ${rtfStats.p95.toFixed(4)}`)
    console.log('')
    console.log('  Wall Time (ms):')
    console.log(`    Mean:   ${wallStats.mean.toFixed(0)}`)
    console.log(`    P50:    ${wallStats.p50.toFixed(0)}`)
    console.log(`    P95:    ${wallStats.p95.toFixed(0)}`)
    console.log('')
    console.log('  Tokens/Second:')
    console.log(`    Mean:   ${tpsStats.mean.toFixed(1)}`)
    console.log(`    P50:    ${tpsStats.p50.toFixed(1)}`)
    console.log('')
    console.log('  Encoder (ms):')
    console.log(`    Mean:   ${encoderStats.mean.toFixed(0)}`)
    console.log(`    P50:    ${encoderStats.p50.toFixed(0)}`)
    console.log('')
    console.log('  Decoder (ms):')
    console.log(`    Mean:   ${decoderStats.mean.toFixed(0)}`)
    console.log(`    P50:    ${decoderStats.p50.toFixed(0)}`)
    console.log('')
    console.log('='.repeat(70) + '\n')

    // --- Write JSON artifact ---
    const report = {
      timestamp: new Date().toISOString(),
      platform,
      isMobile,
      model: {
        type: 'tdt',
        path: modelPath
      },
      audio: {
        durationSec: audioDurationSec,
        samples: audioData.length,
        sampleRate: SAMPLE_RATE
      },
      config: {
        warmupRuns: NUM_WARMUP,
        benchmarkRuns: NUM_BENCHMARK_RUNS,
        maxThreads: config.maxThreads,
        useGPU: config.useGPU
      },
      summary: {
        rtf: rtfStats,
        wallMs: wallStats,
        tokensPerSecond: tpsStats,
        encoderMs: encoderStats,
        decoderMs: decoderStats
      },
      runs: allResults
    }

    try {
      if (!fs.existsSync(RTF_RESULTS_DIR)) {
        fs.mkdirSync(RTF_RESULTS_DIR, { recursive: true })
      }
      const outPath = path.join(RTF_RESULTS_DIR, `rtf-benchmark-${platform}.json`)
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
      console.log(`Results written to ${outPath}\n`)
    } catch (writeErr) {
      console.log(`Warning: could not write results file: ${writeErr.message}`)
    }

    // --- Assertions ---
    t.ok(allResults.length === NUM_BENCHMARK_RUNS,
      `Completed ${NUM_BENCHMARK_RUNS} benchmark runs`)

    t.ok(rtfStats.mean > 0, 'Mean RTF should be positive')

    const RTF_UPPER_BOUND = isMobile ? 5.0 : 2.0
    t.ok(rtfStats.mean <= RTF_UPPER_BOUND,
      `Mean RTF ${rtfStats.mean.toFixed(4)} should be <= ${RTF_UPPER_BOUND}`)

    t.ok(rtfStats.stddev <= rtfStats.mean,
      `RTF stddev ${rtfStats.stddev.toFixed(4)} should be <= mean ${rtfStats.mean.toFixed(4)}`)

    console.log('RTF benchmark completed successfully!\n')
  } finally {
    if (parakeet) {
      try { parakeet.destroyInstance() } catch (_) {}
    }
    try { loggerBinding.releaseLogger() } catch (_) {}
  }
})
